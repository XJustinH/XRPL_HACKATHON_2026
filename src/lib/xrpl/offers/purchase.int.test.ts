import { randomUUID } from "node:crypto";

import { convertHexToString } from "xrpl";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConfirmedLedgerTx,
  LedgerNftOffers,
  TransactionRequest,
  TransactionRequestStatus,
} from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";

import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import { getOfferStatus, PURCHASE_MEMO_TYPE, requestPurchase, type PurchaseDeps } from "./purchase";

/** XRPL-031 primary purchases against Postgres (`npm run test:db`), with Xaman and the ledger faked. */

const db = getDb();
const SELLER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const BUYER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const OTHER_BUYER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const NFT = nftokenIdFor(SELLER, 7, 1);

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(options: { status?: "DRAFT" | "PUBLISHED"; kind?: "PRIMARY" | "RESALE" } = {}) {
  const seller = await db.user.create({
    data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() },
  });
  const buyer = await db.user.create({
    data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig",
      startsAt: new Date("2027-03-12T20:00:00Z"),
      venue: "Rooms",
      city: "Dublin",
      status: options.status ?? "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 5, mintedQuantity: 1 },
  });
  const ticket = await db.ticketNFT.create({
    data: {
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
      issuerAddress: SELLER,
      mintStatus: "MINTED",
      nftokenId: NFT,
      mintTxHash: TX_HASH.replace("E3", "A1"),
      mintedAt: new Date(),
    },
  });
  const offer = await db.nFTOffer.create({
    data: {
      ticketId: ticket.id,
      nftokenId: NFT,
      kind: options.kind ?? "PRIMARY",
      state: "ACTIVE",
      ownerAddress: SELLER,
      amountDrops: "2500000",
      offerIndex: OFFER_INDEX,
      createTxHash: TX_HASH.replace("E3", "B2"),
    },
  });
  return { seller, buyer, event, tier, ticket, offer };
}

function session(userId: string, walletAddress: string | null = BUYER): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role: "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: true,
    method: "DEMO_PERSONA",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress,
    walletVerifiedAt: walletAddress ? new Date() : null,
  };
}

function txRequest(
  status: TransactionRequestStatus,
  extra: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    id: randomUUID(),
    purpose: "ACCEPT_PRIMARY_OFFER",
    reference: null,
    status,
    transactionType: "NFTokenAcceptOffer",
    account: BUYER,
    instruction: "Buy",
    signUrl: "https://xumm.app/sign/x",
    qrPngUrl: "https://xumm.app/sign/x_q.png",
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

interface World {
  /** Status every purchase request reports. */
  status: TransactionRequestStatus;
  extra?: Partial<TransactionRequest>;
  /** Is the sell offer still on the ledger? */
  offerLive: boolean;
  /** Who holds the NFT on the ledger. */
  holder: string;
  buyerBalanceDrops: string;
}

function deps(world: World) {
  const created: TransactionRequest[] = [];
  const create = vi.fn(async (input: { reference?: string | null; txjson: Record<string, unknown> }) => {
    const request = txRequest("PENDING", { reference: input.reference ?? null });
    created.push(request);
    return request;
  });
  const get = vi.fn(async (id: string) => ({
    ...txRequest(world.status, { txHash: TX_HASH, ...world.extra }),
    id,
  }));
  const getValidatedTx = vi.fn(async (hash: string): Promise<ConfirmedLedgerTx> => ({
    hash,
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 2000,
    closeTime: "2026-11-20T22:00:00.000Z",
    transactionType: "NFTokenAcceptOffer",
    account: BUYER,
    nftokenId: NFT,
    offerIndex: null,
    explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
  }));
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.holder === address,
    nft: null,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 2001,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const getOffers = vi.fn(async (nftokenId: string): Promise<LedgerNftOffers> => ({
    nftokenId,
    sellOffers: world.offerLive
      ? [
          {
            offerIndex: OFFER_INDEX,
            nftokenId,
            side: "SELL",
            owner: SELLER,
            amountDrops: "2500000",
            amountIssued: null,
            destination: null,
            expiresAt: null,
            flags: 1,
          },
        ]
      : [],
    buyOffers: [],
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 2002,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const getAccountInfo = vi.fn(async (address: string) => ({
    address,
    exists: true,
    balanceDrops: world.buyerBalanceDrops,
    sequence: 1,
    ownerCount: 0,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 2003,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const getReserves = vi.fn(async () => ({ baseDrops: "1000000", incrementDrops: "200000" }));
  const purchaseDeps: PurchaseDeps = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers, getAccountInfo, getReserves }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" },
  };
  return { purchaseDeps, create, created };
}

const liveWorld = (): World => ({
  status: "PENDING",
  offerLive: true,
  holder: SELLER,
  buyerBalanceDrops: "100000000",
});

describe("requestPurchase", () => {
  it("prepares the buyer's NFTokenAcceptOffer for a live offer and holds the ticket", async () => {
    const { buyer, ticket, offer } = await seed();
    const { purchaseDeps, create } = deps(liveWorld());

    const result = await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });
    expect(result).toMatchObject({
      offerId: offer.id,
      ticketId: ticket.id,
      serial: 1,
      tierName: "GA",
      eventTitle: "Gig",
      amountDrops: "2500000",
    });

    const [input] = create.mock.calls[0] as unknown as [
      { purpose: string; reference: string; txjson: Record<string, unknown>; instruction: string },
    ];
    expect(input.purpose).toBe("ACCEPT_PRIMARY_OFFER");
    expect(input.reference).toBe(offer.id);
    expect(input.txjson).toMatchObject({
      TransactionType: "NFTokenAcceptOffer",
      Account: BUYER,
      NFTokenSellOffer: OFFER_INDEX,
    });
    const memo = (input.txjson.Memos as Array<{ Memo: { MemoType: string; MemoData: string } }>)[0]!.Memo;
    expect(convertHexToString(memo.MemoType)).toBe(PURCHASE_MEMO_TYPE);
    expect(convertHexToString(memo.MemoData)).toBe(offer.id);
    expect(input.instruction).toContain("for 2.5 XRP");

    expect(await db.ledgerTransaction.findFirstOrThrow()).toMatchObject({
      type: "NFTokenAcceptOffer",
      status: "PENDING",
      account: BUYER,
      signRequestRef: result.request.id,
      relatedTicketId: ticket.id,
      relatedOfferId: offer.id,
    });
    // Agent A's inventory counts the ticket as a purchase in flight.
    expect((await getPrimaryAvailability(db, ticket.eventId)).pending).toBe(1);
  });

  it("refuses offers the buyer can't buy, without asking the wallet", async () => {
    const { buyer, seller, ticket, offer } = await seed();
    const { purchaseDeps, create } = deps(liveWorld());
    const attempt = (who: AuthSession, offerId = offer.id) =>
      requestPurchase(purchaseDeps, { session: who, offerId });

    await expect(attempt(session(buyer.id, null))).rejects.toMatchObject({
      status: 403,
      code: "WALLET_NOT_VERIFIED",
    });
    await expect(attempt(session(buyer.id), randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(attempt(session(seller.id, SELLER))).rejects.toThrow(
      "You can't buy a ticket from your own wallet",
    );

    await db.ticketNFT.update({ where: { id: ticket.id }, data: { primarySoldAt: new Date() } });
    await expect(attempt(session(buyer.id))).rejects.toThrow("This ticket is no longer for sale");
    expect(create).not.toHaveBeenCalled();
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("hides offers for events that are not published", async () => {
    const draft = await seed({ status: "DRAFT" });
    const { purchaseDeps } = deps(liveWorld());
    await expect(
      requestPurchase(purchaseDeps, { session: session(draft.buyer.id), offerId: draft.offer.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a buyer who can't pay, with the reason", async () => {
    const { buyer, offer } = await seed();
    const { purchaseDeps } = deps({ ...liveWorld(), buyerBalanceDrops: "2000000" });
    await expect(
      requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("marks an offer taken outside the app as stale and refuses it", async () => {
    const { buyer, offer } = await seed();
    const { purchaseDeps } = deps({ ...liveWorld(), offerLive: false });

    await expect(
      requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id }),
    ).rejects.toThrow("This ticket was just sold or taken off sale");
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("STALE");
  });

  it("lets one buyer at a time hold a ticket", async () => {
    const { buyer, offer } = await seed();
    const other = await db.user.create({
      data: { displayName: "Other", role: "CUSTOMER", onboardedAt: new Date() },
    });
    const { purchaseDeps } = deps(liveWorld());

    const results = await Promise.allSettled([
      requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id }),
      requestPurchase(purchaseDeps, { session: session(other.id, OTHER_BUYER), offerId: offer.id }),
      requestPurchase(purchaseDeps, { session: session(other.id, OTHER_BUYER), offerId: offer.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    expect(await db.ledgerTransaction.count()).toBe(1);
  });

  it("releases the hold when the wallet service is down", async () => {
    const { buyer, offer } = await seed();
    const { purchaseDeps, create } = deps(liveWorld());
    create.mockRejectedValueOnce(new Error("Xaman down"));
    const attempt = () => requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });

    await expect(attempt()).rejects.toThrow("Xaman down");
    expect((await db.ledgerTransaction.findFirstOrThrow()).status).toBe("DROPPED");
    expect((await attempt()).offerId).toBe(offer.id);
  });
});

describe("recording purchases", () => {
  it("records the sale only from the validated purchase, exactly once", async () => {
    const world = liveWorld();
    const { buyer, ticket, offer } = await seed();
    const { purchaseDeps } = deps(world);
    await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });

    world.status = "CONFIRMED";
    world.holder = BUYER;
    world.offerLive = false; // consumed by the purchase
    const status = await getOfferStatus(purchaseDeps, offer.id);
    expect(status).toMatchObject({
      offer: { state: "ACCEPTED", acceptTxHash: TX_HASH },
      ticketId: ticket.id,
      soldAt: "2026-11-20T22:00:00.000Z",
      purchasePending: false,
      acceptTxExplorerUrl: `https://testnet.xrpl.org/transactions/${TX_HASH}`,
    });
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({
      acceptedByAddress: BUYER,
    });
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      primarySoldAt: new Date("2026-11-20T22:00:00.000Z"),
      cachedOwnerAddress: BUYER,
      ownerSyncStatus: "SYNCED",
    });

    await getOfferStatus(purchaseDeps, offer.id); // replay: no second effect
    expect(await db.ledgerTransaction.findMany()).toEqual([
      expect.objectContaining({ hash: TX_HASH, status: "VALIDATED_SUCCESS", appliedAt: expect.any(Date) }),
    ]);
    // Agent A's inventory now counts it as sold.
    expect(await getPrimaryAvailability(db, ticket.eventId)).toMatchObject({ sold: 1, pending: 0 });
  });

  it("tracks a signed purchase as pending until it validates", async () => {
    const world = liveWorld();
    const { buyer, offer } = await seed();
    const { purchaseDeps } = deps(world);
    await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });

    world.status = "SUBMITTED";
    expect(await getOfferStatus(purchaseDeps, offer.id)).toMatchObject({
      offer: { state: "ACTIVE" },
      soldAt: null,
      purchasePending: true,
    });
    expect((await db.ledgerTransaction.findFirstOrThrow()).hash).toBe(TX_HASH);
  });

  it.each(["REJECTED", "EXPIRED", "CANCELLED"] as const)(
    "leaves the ticket available after a %s purchase, once the ledger confirms the offer is still live",
    async (outcome) => {
      const world = liveWorld();
      const { buyer, offer } = await seed();
      const other = await db.user.create({
        data: { displayName: "Next", role: "CUSTOMER", onboardedAt: new Date() },
      });
      const { purchaseDeps } = deps(world);
      await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });

      world.status = outcome;
      expect(await getOfferStatus(purchaseDeps, offer.id)).toMatchObject({
        offer: { state: "ACTIVE" },
        soldAt: null,
        purchasePending: false,
      });
      expect((await db.ledgerTransaction.findFirstOrThrow()).status).toBe("DROPPED");

      // Someone else can buy it now.
      world.status = "PENDING";
      expect(
        (await requestPurchase(purchaseDeps, { session: session(other.id, OTHER_BUYER), offerId: offer.id }))
          .offerId,
      ).toBe(offer.id);
    },
  );

  it("marks the offer stale when a failed purchase finds it gone from the ledger", async () => {
    const world = liveWorld();
    const { buyer, offer } = await seed();
    const { purchaseDeps } = deps(world);
    await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id });

    world.status = "FAILED";
    world.extra = { failureReason: "LEDGER_REJECTED", engineResult: "tecOBJECT_NOT_FOUND" };
    world.offerLive = false; // bought by someone outside the app first
    world.holder = OTHER_BUYER;
    expect((await getOfferStatus(purchaseDeps, offer.id)).offer.state).toBe("STALE");
    expect(await db.ledgerTransaction.findFirstOrThrow()).toMatchObject({
      status: "VALIDATED_FAILURE",
      resultCode: "tecOBJECT_NOT_FOUND",
    });
  });

  it("releases a hold whose wallet request was never created", async () => {
    const { buyer, ticket, offer } = await seed();
    const { purchaseDeps } = deps(liveWorld());
    await db.ledgerTransaction.create({
      data: {
        type: "NFTokenAcceptOffer",
        account: OTHER_BUYER,
        status: "PENDING",
        relatedTicketId: ticket.id,
        relatedOfferId: offer.id,
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    });

    // The orphaned hold no longer blocks the ticket.
    expect(
      (await requestPurchase(purchaseDeps, { session: session(buyer.id), offerId: offer.id })).offerId,
    ).toBe(offer.id);
  });
});
