import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/sellers/me/analytics/route";
import type { ConfirmedLedgerTx } from "@/contracts/xrpl";
import { createSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { XrplServiceError } from "@/lib/xrpl/errors";
import { checkSalesOnLedger, getStorefrontMetrics } from "./storefront-metrics";

/** XRPL-078 storefront analytics against Postgres (`npm run test:db`). */

const db = getDb();
const config = { explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" };
const hex = (prefix: string, i: number) => (prefix + i.toString(16)).toUpperCase().padStart(64, "0");
const WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
let n = 0;

beforeEach(async () => {
  n = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE "MerchOrderItem","MerchOrder","PhysicalProduct","CollectibleToken","Collectible","MediaAsset","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","Session","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

const user = (displayName: string, role: "SELLER" | "CUSTOMER" = "SELLER") =>
  db.user.create({ data: { displayName, role, onboardedAt: new Date() } });

type OrderStatus = "NEW" | "PROCESSING" | "SHIPPED" | "FULFILLED" | "CANCELLED";

/** An order with one line per `[unit price, quantity]`. `totalDrops` overrides the stored total. */
async function order(
  sellerId: string,
  buyerId: string,
  status: OrderStatus,
  lines: [priceDrops: string, quantity: number][],
  totalDrops?: string,
) {
  const items = [];
  for (const [priceDrops, quantity] of lines) {
    n += 1;
    const product = await db.physicalProduct.create({
      data: { sellerId, name: `Product ${n}`, priceDrops, stock: 10, status: "PUBLISHED", publishedAt: new Date() },
    });
    items.push({ productId: product.id, productName: product.name, unitPriceDrops: priceDrops, quantity });
  }
  const total = lines.reduce((sum, [price, quantity]) => sum + BigInt(price) * BigInt(quantity), BigInt(0));
  return db.merchOrder.create({
    data: {
      sellerId,
      buyerId,
      status,
      totalDrops: totalDrops ?? total.toString(),
      shippingName: "Aoife Murphy",
      shippingAddress: "1 Main Street, Dublin",
      items: { create: items },
    },
  });
}

type TokenState = "SOLD" | "FOR_SALE" | "BUYING" | "MINTING" | "MINT_FAILED" | "STALE" | "LISTING" | "UNMINTED";

/** A collectible with one edition per state, each priced at `priceDrops`. */
async function collectible(
  sellerId: string,
  states: TokenState[],
  priceDrops = "5000000",
  status: "PUBLISHED" | "DRAFT" = "PUBLISHED",
) {
  n += 1;
  const media = await db.mediaAsset.create({
    data: {
      uploaderId: sellerId,
      kind: "IMAGE",
      mimeType: "image/png",
      sizeBytes: 16,
      storageKey: `test-${n}.png`,
      originalName: "cover.png",
      rightsConfirmedAt: new Date(),
    },
  });
  const row = await db.collectible.create({
    data: {
      sellerId,
      mediaAssetId: media.id,
      title: `Poster ${n}`,
      editionSize: states.length,
      priceDrops,
      rightsStatement: "Personal use.",
      status,
      publishedAt: status === "PUBLISHED" ? new Date() : null,
    },
  });
  const tokens = [];
  for (const [index, state] of states.entries()) {
    n += 1;
    const minted = !["MINTING", "MINT_FAILED", "UNMINTED"].includes(state);
    const offered = ["SOLD", "FOR_SALE", "BUYING", "STALE"].includes(state);
    tokens.push(
      await db.collectibleToken.create({
        data: {
          collectibleId: row.id,
          edition: index + 1,
          metadataUri: `http://localhost:3000/api/collectibles/tokens/${n}/metadata`,
          mintStatus: minted ? "MINTED" : state === "MINTING" ? "PENDING" : state === "MINT_FAILED" ? "FAILED" : "NOT_MINTED",
          nftokenId: minted ? hex("A", n) : null,
          mintTxHash: minted ? hex("B", n) : null,
          issuerAddress: minted ? WALLET : null,
          offerStatus:
            state === "SOLD" ? "ACCEPTED" : state === "STALE" ? "STALE" : state === "LISTING" ? "PENDING" : offered ? "ACTIVE" : "NONE",
          offerIndex: offered ? hex("C", n) : null,
          offerTxHash: offered ? hex("D", n) : null,
          offerAmountDrops: offered || state === "LISTING" ? priceDrops : null,
          saleStatus: state === "SOLD" ? "SOLD" : state === "BUYING" ? "PENDING" : "NONE",
          saleTxHash: state === "SOLD" ? hex("E", n) : null,
          soldAt: state === "SOLD" ? new Date(Date.UTC(2026, 10, 21, 10, n)) : null,
        },
      }),
    );
  }
  return { row, tokens };
}

describe("getStorefrontMetrics", () => {
  it("reports merchandise orders by status, in XRP with simulated payment, and never counts cancelled orders", async () => {
    const seller = await user("Band");
    const fan = await user("Fan", "CUSTOMER");
    await order(seller.id, fan.id, "NEW", [["15000000", 2]]); // 30 XRP, 2 units
    await order(seller.id, fan.id, "SHIPPED", [["15000000", 1], ["4000000", 3]]); // 27 XRP, 4 units
    await order(seller.id, fan.id, "FULFILLED", [["4000000", 1]]); // 4 XRP, 1 unit
    await order(seller.id, fan.id, "CANCELLED", [["15000000", 5]]); // 75 XRP, not counted
    // Another seller's order is never part of this seller's figures.
    const other = await user("Other band");
    await order(other.id, fan.id, "NEW", [["99000000", 1]]);

    const { merchandise } = await getStorefrontMetrics(db, seller.id, config);
    expect(merchandise).toMatchObject({
      currency: "XRP",
      settlement: "SIMULATED",
      orders: 4,
      ordersCounted: 3,
      unitsSold: 7,
      orderValueDrops: "61000000",
      cancelledDrops: "75000000",
    });
    expect(merchandise.byStatus).toEqual([
      { status: "NEW", orders: 1, units: 2, totalDrops: "30000000" },
      { status: "PROCESSING", orders: 0, units: 0, totalDrops: "0" },
      { status: "SHIPPED", orders: 1, units: 4, totalDrops: "27000000" },
      { status: "FULFILLED", orders: 1, units: 1, totalDrops: "4000000" },
      { status: "CANCELLED", orders: 1, units: 5, totalDrops: "75000000" },
    ]);
    // The headline value plus the cancelled value is every order record, and matches the order lines.
    expect(merchandise.reconciliation).toEqual({
      orderTotalsDrops: "136000000",
      lineTotalsDrops: "136000000",
      mismatchedOrderIds: [],
      reconciled: true,
    });
    const stored = await db.merchOrder.findMany({ where: { sellerId: seller.id, status: { not: "CANCELLED" } } });
    expect(stored.reduce((sum, o) => sum + BigInt(o.totalDrops), BigInt(0)).toString()).toBe(merchandise.orderValueDrops);
  });

  it("names the order whose stored total does not match its own lines", async () => {
    const seller = await user("Band");
    const fan = await user("Fan", "CUSTOMER");
    await order(seller.id, fan.id, "NEW", [["15000000", 1]]);
    const wrong = await order(seller.id, fan.id, "NEW", [["15000000", 2]], "29000000");

    const { merchandise } = await getStorefrontMetrics(db, seller.id, config);
    expect(merchandise.reconciliation).toEqual({
      orderTotalsDrops: "44000000",
      lineTotalsDrops: "45000000",
      mismatchedOrderIds: [wrong.id],
      reconciled: false,
    });
  });

  it("counts a collectible sale only from its validated purchase, and keeps pending and failed ones apart", async () => {
    const seller = await user("Band");
    const first = await collectible(seller.id, ["SOLD", "SOLD", "FOR_SALE", "BUYING", "MINTING", "UNMINTED"], "5000000");
    const second = await collectible(seller.id, ["SOLD", "STALE", "MINT_FAILED", "LISTING"], "2500000");
    // A draft and another seller's sale are never counted.
    await collectible(seller.id, ["UNMINTED"], "9000000", "DRAFT");
    await collectible((await user("Other band")).id, ["SOLD"], "99000000");

    const { collectibles } = await getStorefrontMetrics(db, seller.id, config);
    expect(collectibles).toMatchObject({
      currency: "XRP",
      settlement: "XRPL",
      networkLabel: "XRPL Testnet",
      listings: 2,
      editions: 10,
      minted: 7,
      forSale: 1,
      sold: 3,
      revenueDrops: "12500000",
      pending: { mints: 1, listings: 1, purchases: 1 },
      notCompleted: { failedMints: 1, failedListings: 0, staleOffers: 1 },
      reconciliation: { salesWithTransaction: 3, salesWithTransactionDrops: "12500000", reconciled: true },
      salesTruncated: false,
    });

    // Every counted sale is listed with the transaction it was recorded from, newest first.
    const soldTokens = [...first.tokens, ...second.tokens].filter((t) => t.saleStatus === "SOLD");
    expect(collectibles.sales.map((sale) => sale.txHash).sort()).toEqual(soldTokens.map((t) => t.saleTxHash).sort());
    expect(collectibles.sales[0]).toMatchObject({
      tokenId: second.tokens[0]?.id,
      title: second.row.title,
      edition: 1,
      editionSize: 4,
      amountDrops: "2500000",
      explorerUrl: `https://testnet.xrpl.org/transactions/${second.tokens[0]?.saleTxHash}`,
    });
    const listedTotal = collectibles.sales.reduce((sum, sale) => sum + BigInt(sale.amountDrops), BigInt(0));
    expect(listedTotal.toString()).toBe(collectibles.revenueDrops);
  });

  it("does not call a sale reconciled when it has no validated transaction recorded", async () => {
    const seller = await user("Band");
    const { tokens } = await collectible(seller.id, ["SOLD", "SOLD"], "5000000");
    await db.collectibleToken.update({ where: { id: tokens[1]?.id }, data: { saleTxHash: null } });

    const { collectibles } = await getStorefrontMetrics(db, seller.id, config);
    expect(collectibles).toMatchObject({
      sold: 2,
      revenueDrops: "10000000",
      reconciliation: { salesWithTransaction: 1, salesWithTransactionDrops: "5000000", reconciled: false },
    });
  });

  it("summarises validated ticket sales across the seller's events, apart from the other two", async () => {
    const seller = await user("Venue");
    const event = await db.event.create({
      data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "Dublin", status: "PUBLISHED" },
    });
    const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 4 } });
    const ticket = await db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial: 1,
        mintStatus: "MINTED",
        nftokenId: hex("A", 1),
        mintTxHash: hex("B", 1),
        mintedAt: new Date(),
        primarySoldAt: new Date(),
        primarySaleTxHash: hex("C", 1),
      },
    });
    const offer = (kind: "PRIMARY" | "RESALE", state: "ACCEPTED" | "ACTIVE", amountDrops: string, i: number) =>
      db.nFTOffer.create({
        data: { ticketId: ticket.id, nftokenId: hex("A", 1), offerIndex: hex("D", i), kind, state, ownerAddress: WALLET, amountDrops },
      });
    await offer("PRIMARY", "ACCEPTED", "2500000", 1);
    await offer("RESALE", "ACCEPTED", "4000000", 2); // a holder's resale is not the seller's revenue
    await offer("RESALE", "ACTIVE", "9000000", 3);

    const metrics = await getStorefrontMetrics(db, seller.id, config, new Date("2026-11-21T06:00:00.000Z"));
    expect(metrics.tickets).toEqual({ currency: "XRP", settlement: "XRPL", events: 1, sold: 1, revenueDrops: "2500000" });
    // Nothing leaks between the three sections.
    expect(metrics.merchandise).toMatchObject({ orders: 0, orderValueDrops: "0" });
    expect(metrics.collectibles).toMatchObject({ sold: 0, revenueDrops: "0", sales: [] });
    expect(metrics).toMatchObject({ sellerId: seller.id, calculatedAt: "2026-11-21T06:00:00.000Z" });
  });
});

describe("checkSalesOnLedger", () => {
  const tx = (over: Partial<ConfirmedLedgerTx>): ConfirmedLedgerTx => ({
    hash: hex("E", 1),
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 1234,
    closeTime: "2026-11-21T10:00:00.000Z",
    transactionType: "NFTokenAcceptOffer",
    account: WALLET,
    nftokenId: hex("A", 1),
    offerIndex: null,
    acceptedSellOfferIndex: hex("C", 1),
    explorerUrl: "https://testnet.xrpl.org/transactions/x",
    ...over,
  });

  it("confirms a sale only when the validated transaction moved that NFT, and never guesses", async () => {
    const getValidatedTx = vi
      .fn()
      .mockResolvedValueOnce(tx({}))
      .mockResolvedValueOnce(tx({ nftokenId: hex("A", 99) }))
      .mockRejectedValueOnce(new XrplServiceError("TX_FAILED", "validated with tecNO_PERMISSION"))
      .mockRejectedValueOnce(new XrplServiceError("NOT_VALIDATED", "not in a validated ledger"))
      .mockRejectedValueOnce(new Error("socket closed"));
    const sale = (i: number) => ({ txHash: hex("E", i), nftokenId: hex("A", 1) });

    const checks = await checkSalesOnLedger({ getValidatedTx }, [
      sale(1),
      sale(2),
      sale(3),
      sale(4),
      sale(5),
      { txHash: null, nftokenId: hex("A", 1) },
    ]);
    expect(checks.map((check) => check.outcome)).toEqual(["VALIDATED", "MISMATCH", "MISMATCH", "UNAVAILABLE", "UNAVAILABLE"]);
    expect(checks[0]).toEqual({ txHash: hex("E", 1), outcome: "VALIDATED", ledgerIndex: 1234 });
    // A sale with no hash is not looked up at all.
    expect(getValidatedTx).toHaveBeenCalledTimes(5);
  });
});

describe("GET /api/sellers/me/analytics", () => {
  const request = (token?: string) =>
    new Request("http://localhost/api/sellers/me/analytics", {
      headers: token ? { cookie: `xt_session=${token}` } : {},
    });

  it("returns the signed-in seller's own summary, and refuses customers and visitors", async () => {
    const seller = await user("Band");
    const fan = await user("Fan", "CUSTOMER");
    await order(seller.id, fan.id, "NEW", [["15000000", 2]]);
    await collectible(seller.id, ["SOLD"], "5000000");

    expect((await GET(request(), {})).status).toBe(401);

    const customer = await createSession(db, fan.id, "ONBOARDING");
    expect((await GET(request(customer.token), {})).status).toBe(403);

    const session = await createSession(db, seller.id, "ONBOARDING");
    const response = await GET(request(session.token), {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { data } = (await response.json()) as { data: Awaited<ReturnType<typeof getStorefrontMetrics>> };
    expect(data).toMatchObject({
      sellerId: seller.id,
      merchandise: { ordersCounted: 1, orderValueDrops: "30000000", settlement: "SIMULATED" },
      collectibles: { sold: 1, revenueDrops: "5000000", settlement: "XRPL" },
    });
  });
});
