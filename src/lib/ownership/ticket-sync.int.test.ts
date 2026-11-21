import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { XrplServiceError } from "@/lib/xrpl/errors";
import type { HolderOfferDeps } from "@/lib/xrpl/offers/holder";
import type { TicketSyncDeps } from "./ticket-sync";

/**
 * XRPL-043 against Postgres: keeping a ticket in step with the ledger after it moves, in the app or
 * outside it. The ledger is a controllable fake shaped like Agent B's read service; everything else
 * (Agent B's offer services, ownership reads and holder offers) is the real code.
 */

const world = vi.hoisted(() => ({
  owners: new Map<string, string>(),
  burned: new Set<string>(),
  /** Sell offers on the ledger, by NFT. */
  sellOffers: new Map<string, { offerIndex: string; owner: string; amountDrops: string; destination: string | null }[]>(),
  txs: new Map<string, unknown>(),
  /** Wallet requests (Xaman) by reference. */
  requests: new Map<string, unknown>(),
  ledgerIndex: 6000,
  reset() {
    this.owners.clear();
    this.burned.clear();
    this.sellOffers.clear();
    this.txs.clear();
    this.requests.clear();
    this.ledgerIndex = 6000;
  },
}));

const provenance = () => ({
  endpoint: "wss://node",
  ledgerIndex: world.ledgerIndex,
  ledgerHash: null,
  validated: true,
  fetchedAt: "",
});
const fakeLedger = {
  async getOwner(nftokenId: string) {
    const owner = world.owners.get(nftokenId);
    if (!owner) throw new XrplServiceError("NOT_FOUND", "NFT not found");
    return { nftokenId, ownerAddress: owner, isBurned: world.burned.has(nftokenId), nft: null, provenance: provenance() };
  },
  async verifyOwner(nftokenId: string, address: string) {
    const owns = !world.burned.has(nftokenId) && world.owners.get(nftokenId) === address;
    return { nftokenId, address, owns, nft: null, provenance: provenance() };
  },
  async getAccountNfts() {
    return { items: [], nextCursor: null, provenance: provenance() };
  },
  async getOffers(nftokenId: string) {
    const sellOffers = (world.sellOffers.get(nftokenId) ?? []).map((o) => ({
      ...o,
      nftokenId,
      side: "SELL",
      amountIssued: null,
      expiresAt: null,
      flags: 1,
    }));
    return { nftokenId, sellOffers, buyOffers: [], provenance: provenance() };
  },
  async getValidatedTx(hash: string) {
    const tx = world.txs.get(hash);
    if (!tx) throw new XrplServiceError("NOT_VALIDATED", `Transaction ${hash} is not validated yet`);
    return tx;
  },
  // Holder offers also check the wallet can cover one more owner reserve (Agent B, #176).
  async getAccountInfo(address: string) {
    return { address, exists: true, balanceDrops: "100000000", sequence: 1, ownerCount: 0, provenance: provenance() };
  },
  async getReserves() {
    return { baseDrops: "1000000", incrementDrops: "200000" };
  },
};

const db = (await import("@/lib/db/client")).getDb();
const deps = {
  db,
  transactions: () => ({
    create: async () => {
      throw new Error("No wallet request should be created here");
    },
    get: async (ref: string) => world.requests.get(ref) ?? { status: "PENDING" },
  }),
  ledger: () => fakeLedger,
  config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org" },
} as unknown as TicketSyncDeps & HolderOfferDeps;

vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => deps }));
// Route handlers call connection() to opt out of prerendering; there is no request scope in tests.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => {},
}));

const { reconcileTicket } = await import("./ticket-sync");
const { getTicketHistory } = await import("./history");
const { requestHolderOffer } = await import("@/lib/xrpl/offers/holder");
const { requireTicketOwner } = await import("@/lib/auth/permissions");
const { createSession, sessionCookieName } = await import("@/lib/auth/session");
const { POST: reconcilePOST } = await import("@/app/api/tickets/[id]/reconcile/route");
const { GET: historyGET } = await import("@/app/api/tickets/[id]/history/route");

const SELLER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BUYER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const OTHER = "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
let seq = 0;
const hex64 = () => (++seq).toString(16).toUpperCase().padStart(64, "0");

/** A validated transaction the app recorded, in `ledgerIndex`. */
async function recordedTx(hash: string, type: "NFTokenMint" | "NFTokenCreateOffer" | "NFTokenAcceptOffer", ledgerIndex: number) {
  await db.ledgerTransaction.create({
    data: {
      hash,
      type,
      status: "VALIDATED_SUCCESS",
      ledgerIndex,
      validatedAt: new Date(Date.UTC(2026, 10, 21, 10, 0, ledgerIndex % 60)),
      appliedAt: new Date(),
    },
  });
}

/** An app offer for the ticket, also live on the ledger. */
async function liveOffer(
  ticket: { id: string; nftokenId: string | null },
  kind: "RESALE" | "GIFT",
  owner: string,
  ledgerIndex: number,
) {
  const createTxHash = hex64();
  await recordedTx(createTxHash, "NFTokenCreateOffer", ledgerIndex);
  const offer = await db.nFTOffer.create({
    data: {
      ticketId: ticket.id,
      nftokenId: ticket.nftokenId!,
      offerIndex: hex64(),
      kind,
      state: "ACTIVE",
      ownerAddress: owner,
      amountDrops: kind === "GIFT" ? "0" : "30000000",
      destinationAddress: kind === "GIFT" ? FRIEND : null,
      createTxHash,
    },
  });
  world.sellOffers.set(ticket.nftokenId!, [
    ...(world.sellOffers.get(ticket.nftokenId!) ?? []),
    { offerIndex: offer.offerIndex!, owner, amountDrops: offer.amountDrops, destination: offer.destinationAddress },
  ]);
  return offer;
}

/** A published event's ticket: minted by the seller (ledger 4000), bought by BUYER through the app (4200). */
async function boughtTicket() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER", onboardedAt: new Date() } });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      status: "PUBLISHED",
      publishedAt: new Date(),
      title: "Gig",
      startsAt: new Date(Date.now() + 30 * 24 * 3600_000),
      venue: "Vicar St",
      city: "Dublin",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "25000000", totalSupply: 1, mintedQuantity: 1 },
  });
  const [mintTxHash, listTxHash, saleTxHash] = [hex64(), hex64(), hex64()];
  await recordedTx(mintTxHash, "NFTokenMint", 4000);
  await recordedTx(listTxHash, "NFTokenCreateOffer", 4100);
  await recordedTx(saleTxHash, "NFTokenAcceptOffer", 4200);
  const ticket = await db.ticketNFT.create({
    data: {
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
      nftokenId: hex64(),
      issuerAddress: SELLER_WALLET,
      metadataUri: "https://tickets.example/meta/1.json",
      mintStatus: "MINTED",
      mintTxHash,
      mintedAt: new Date(),
      primarySoldAt: new Date(),
      primarySaleTxHash: saleTxHash,
      cachedOwnerAddress: BUYER,
      ownerSyncStatus: "SYNCED",
      ownerSyncLedgerIndex: 4200,
    },
  });
  await db.nFTOffer.create({
    data: {
      ticketId: ticket.id,
      nftokenId: ticket.nftokenId!,
      offerIndex: hex64(),
      kind: "PRIMARY",
      state: "ACCEPTED",
      ownerAddress: SELLER_WALLET,
      amountDrops: "25000000",
      createTxHash: listTxHash,
      acceptTxHash: saleTxHash,
      acceptedByAddress: BUYER,
    },
  });
  world.owners.set(ticket.nftokenId!, BUYER);
  return { seller, event, ticket };
}

const sessionFor = (userId: string, walletAddress: string) =>
  ({
    sessionId: "s",
    userId,
    displayName: "Holder",
    role: "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "WALLET",
    expiresAt: new Date(Date.now() + 3600_000),
    walletAddress,
    walletVerifiedAt: new Date(),
  }) as never;

beforeEach(async () => {
  world.reset();
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("reconciling a ticket with the ledger", () => {
  it("records the new owner after a move outside the app, and closes the old holder's listing", async () => {
    const { ticket } = await boughtTicket();
    const listing = await liveOffer(ticket, "RESALE", BUYER, 5000);
    world.owners.set(ticket.nftokenId!, OTHER); // BUYER sent it to OTHER with another wallet app

    const result = await reconcileTicket(deps, { ticketId: ticket.id });
    expect(result.ownership).toMatchObject({
      status: "VERIFIED",
      ownerAddress: OTHER,
      previousOwnerAddress: BUYER,
      changed: true,
      ledgerIndex: 6000,
    });
    expect(result.offers).toEqual([
      { offerId: listing.id, kind: "RESALE", ownerAddress: BUYER, previousState: "ACTIVE", state: "STALE" },
    ]);
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      cachedOwnerAddress: OTHER,
      ownerSyncStatus: "SYNCED",
      ownerSyncLedgerIndex: 6000,
    });
    expect(await db.nFTOffer.count({ where: { ticketId: ticket.id, state: "ACTIVE" } })).toBe(0);

    // Safe to repeat.
    expect((await reconcileTicket(deps, { ticketId: ticket.id })).ownership.changed).toBe(false);
  });

  it("stops the previous holder from acting on the ticket, while the new holder can", async () => {
    const { ticket } = await boughtTicket();
    const buyer = await db.user.create({ data: { displayName: "Buyer", onboardedAt: new Date() } });
    const other = await db.user.create({ data: { displayName: "Other", onboardedAt: new Date() } });
    world.owners.set(ticket.nftokenId!, OTHER);
    await reconcileTicket(deps, { ticketId: ticket.id });

    await expect(
      requestHolderOffer(deps, {
        session: sessionFor(buyer.id, BUYER),
        ticketId: ticket.id,
        offer: { kind: "GIFT", destination: FRIEND },
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/doesn't hold this ticket/) });
    await expect(requireTicketOwner(db, sessionFor(buyer.id, BUYER), ticket.id, fakeLedger)).rejects.toMatchObject({
      status: 403,
    });
    await expect(requireTicketOwner(db, sessionFor(other.id, OTHER), ticket.id, fakeLedger)).resolves.toMatchObject({
      ownerAddress: OTHER,
    });
  });

  it("keeps a listing the ledger still backs, and records a purchase that reached the ledger first", async () => {
    const { ticket } = await boughtTicket();
    const resale = await liveOffer(ticket, "RESALE", BUYER, 5000);
    expect((await reconcileTicket(deps, { ticketId: ticket.id })).offers[0]?.state).toBe("ACTIVE");

    // FRIEND bought it through the app; the wallet request is confirmed but not yet recorded.
    const saleHash = hex64();
    world.txs.set(saleHash, {
      hash: saleHash,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: 5900,
      closeTime: "2026-11-21T11:00:00.000Z",
      transactionType: "NFTokenAcceptOffer",
      account: FRIEND,
      nftokenId: ticket.nftokenId,
      offerIndex: null,
      acceptedSellOfferIndex: resale.offerIndex,
      explorerUrl: "",
    });
    world.requests.set("8b3d2f3e-2b8a-4d6c-9a51-1f8f0d2b7c11", { status: "CONFIRMED", txHash: saleHash });
    await db.ledgerTransaction.create({
      data: {
        type: "NFTokenAcceptOffer",
        status: "PENDING",
        account: FRIEND,
        relatedOfferId: resale.id,
        relatedTicketId: ticket.id,
        signRequestRef: "8b3d2f3e-2b8a-4d6c-9a51-1f8f0d2b7c11",
      },
    });
    world.owners.set(ticket.nftokenId!, FRIEND);
    world.sellOffers.delete(ticket.nftokenId!);

    const result = await reconcileTicket(deps, { ticketId: ticket.id });
    expect(result.offers).toEqual([
      { offerId: resale.id, kind: "RESALE", ownerAddress: BUYER, previousState: "ACTIVE", state: "ACCEPTED" },
    ]);
    expect(result.ownership).toMatchObject({ ownerAddress: FRIEND, previousOwnerAddress: FRIEND, changed: false });
  });

  it("closes every listing of a ticket whose NFT was burned", async () => {
    const { ticket } = await boughtTicket();
    await liveOffer(ticket, "RESALE", BUYER, 5000);
    world.burned.add(ticket.nftokenId!);

    const result = await reconcileTicket(deps, { ticketId: ticket.id });
    expect(result.ownership.status).toBe("BURNED");
    expect(result.offers.map((o) => o.state)).toEqual(["STALE"]);
  });

  it("404s for an unknown ticket", async () => {
    await expect(reconcileTicket(deps, { ticketId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("a ticket's transfer history", () => {
  it("shows the app's own steps, then the move outside the app", async () => {
    const { ticket } = await boughtTicket();
    await liveOffer(ticket, "RESALE", BUYER, 5000); // never accepted: not part of the history
    world.owners.set(ticket.nftokenId!, OTHER);
    const { ownership } = await reconcileTicket(deps, { ticketId: ticket.id });

    const history = await getTicketHistory(deps, ticket.id, ownership);
    expect(history.ownerVerified).toBe(true);
    expect(history.entries.map((e) => [e.kind, e.source, e.fromAddress, e.toAddress, e.ledgerIndex])).toEqual([
      ["MINT", "PLATFORM", null, SELLER_WALLET, 4000],
      ["PRIMARY_SALE", "PLATFORM", SELLER_WALLET, BUYER, 4200],
      ["OUTSIDE_APP", "EXTERNAL", BUYER, OTHER, 6000],
    ]);
    expect(history.entries[1]).toMatchObject({
      amountDrops: "25000000",
      txHash: ticket.primarySaleTxHash,
      explorerTxUrl: `https://testnet.xrpl.org/transactions/${ticket.primarySaleTxHash}`,
    });
    expect(history.entries[2]).toMatchObject({ txHash: null, amountDrops: null, at: null });
  });

  it("shows a gap between the app's own steps as a move outside the app", async () => {
    const { ticket } = await boughtTicket();
    // BUYER passed it to OTHER outside the app; OTHER then resold it to FRIEND through the app.
    world.owners.set(ticket.nftokenId!, OTHER);
    const resale = await liveOffer(ticket, "RESALE", OTHER, 5000);
    const resaleTx = hex64();
    await recordedTx(resaleTx, "NFTokenAcceptOffer", 5500);
    await db.nFTOffer.update({
      where: { id: resale.id },
      data: { state: "ACCEPTED", acceptTxHash: resaleTx, acceptedByAddress: FRIEND },
    });
    world.owners.set(ticket.nftokenId!, FRIEND);

    const history = await getTicketHistory(deps, ticket.id, await reconcileTicket(deps, { ticketId: ticket.id }).then((r) => r.ownership));
    expect(history.entries.map((e) => [e.kind, e.source, e.fromAddress, e.toAddress, e.ledgerIndex])).toEqual([
      ["MINT", "PLATFORM", null, SELLER_WALLET, 4000],
      ["PRIMARY_SALE", "PLATFORM", SELLER_WALLET, BUYER, 4200],
      // Seen when OTHER's listing was validated, in ledger 5000.
      ["OUTSIDE_APP", "EXTERNAL", BUYER, OTHER, 5000],
      ["RESALE", "PLATFORM", OTHER, FRIEND, 5500],
    ]);
  });

  it("ends at the last recorded step when the owner can't be verified", async () => {
    const { ticket } = await boughtTicket();
    const history = await getTicketHistory(deps, ticket.id, { status: "PENDING", ownerAddress: null, ledgerIndex: null });
    expect(history.ownerVerified).toBe(false);
    expect(history.entries.map((e) => e.kind)).toEqual(["MINT", "PRIMARY_SALE"]);
  });
});

describe("routes", () => {
  const ORIGIN = "http://localhost:3000";
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  it("POST /api/tickets/:id/reconcile needs a session and returns the result", async () => {
    const { seller, ticket } = await boughtTicket();
    world.owners.set(ticket.nftokenId!, OTHER);
    const cookie = `${sessionCookieName()}=${(await createSession(db, seller.id, "ONBOARDING")).token}`;
    const post = (id: string, withCookie = true) =>
      reconcilePOST(
        new Request(`${ORIGIN}/api/tickets/${id}/reconcile`, {
          method: "POST",
          headers: { origin: ORIGIN, ...(withCookie ? { cookie } : {}) },
        }),
        params(id),
      );

    expect((await post(ticket.id, false)).status).toBe(401);
    expect((await post("not-a-uuid")).status).toBe(404);
    expect((await post("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const res = await post(ticket.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data.ownership).toMatchObject({ ownerAddress: OTHER, changed: true });
  });

  it("GET /api/tickets/:id/history is public and reads the owner first", async () => {
    const { ticket } = await boughtTicket();
    world.owners.set(ticket.nftokenId!, OTHER);
    const get = (id: string) => historyGET(new Request(`${ORIGIN}/api/tickets/${id}/history`), params(id));

    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const res = await get(ticket.id);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.ownerVerified).toBe(true);
    expect(data.entries.at(-1)).toMatchObject({ kind: "OUTSIDE_APP", fromAddress: BUYER, toAddress: OTHER });
  });
});
