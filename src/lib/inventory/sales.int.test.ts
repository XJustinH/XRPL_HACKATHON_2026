import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { XrplServiceError } from "@/lib/xrpl/errors";
import type { SalesLedger } from "./sales";

/**
 * XRPL-032 against Postgres: recording validated primary sales exactly once, whether they come
 * from the app's purchase flow (Agent B) or another wallet, and the sold-out state that follows.
 */

type Tx = Awaited<ReturnType<SalesLedger["getValidatedTx"]>>;

// A controllable ledger, also used by the route through a module mock.
const ledger = vi.hoisted(() => {
  const txs = new Map<string, unknown>();
  const owners = new Map<string, string>();
  return {
    txs,
    owners,
    pending: new Set<string>(),
    reset() {
      txs.clear();
      owners.clear();
      this.pending.clear();
    },
  };
});

const fakeLedger: SalesLedger = {
  async getValidatedTx(hash) {
    if (ledger.pending.has(hash)) throw new XrplServiceError("NOT_VALIDATED", "Transaction is not validated yet");
    const tx = ledger.txs.get(hash);
    if (!tx) throw new XrplServiceError("NOT_FOUND", "Transaction not found");
    return tx as Tx;
  },
  async verifyOwner(nftokenId, address) {
    return { owns: ledger.owners.get(nftokenId) === address, provenance: { ledgerIndex: 4242, validated: true } };
  },
};

vi.mock("@/lib/xrpl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/xrpl")>()),
  getXrplQueryService: () => fakeLedger,
}));

const { POST: reconcilePOST } = await import("@/app/api/ledger/transactions/[hash]/reconcile/route");
const { createSession, sessionCookieName } = await import("@/lib/auth/session");
const { getDb } = await import("@/lib/db/client");
const { ResalePolicy } = await import("@/lib/resale-policy/resale-policy");
const { reconcilePurchase } = await import("@/lib/xrpl/offers/purchase");
const { createInventoryPort, getPrimaryAvailability } = await import("./primary-inventory");
const { reconcileLedgerTransaction } = await import("./sales");

const db = getDb();
const deps = { db, ledger: () => fakeLedger };
const SELLER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const BUYER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const CLOSE_TIME = "2026-11-21T10:00:00.000Z";
let seq = 0;
const hex64 = () => (++seq).toString(16).toUpperCase().padStart(64, "0");

/** A published event whose tickets are minted and listed for primary sale. */
async function listedEvent(tickets = 2) {
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
    data: { eventId: event.id, name: "GA", priceDrops: "25000000", totalSupply: tickets, mintedQuantity: tickets },
  });
  const offers = [];
  for (let serial = 1; serial <= tickets; serial++) {
    const ticket = await db.ticketNFT.create({
      data: { eventId: event.id, tierId: tier.id, serial, nftokenId: hex64(), mintStatus: "MINTED", mintTxHash: hex64(), mintedAt: new Date() },
    });
    offers.push(
      await db.nFTOffer.create({
        data: {
          ticketId: ticket.id,
          nftokenId: ticket.nftokenId!,
          offerIndex: hex64(),
          kind: "PRIMARY",
          state: "ACTIVE",
          ownerAddress: SELLER_WALLET,
          amountDrops: "25000000",
        },
      }),
    );
  }
  return { seller, event, offers };
}

/**
 * The buyer accepts `offer` on the ledger: a validated NFTokenAcceptOffer, shaped as Agent B's reader
 * reports it (checked on Testnet): the offer taken is `acceptedSellOfferIndex`, and `offerIndex`, which is
 * for offers created, is null. With `broker`, a broker submits the accept and the NFT goes to `buyer`.
 */
function acceptOnLedger(
  offer: { offerIndex: string | null; nftokenId: string },
  buyer = BUYER,
  { broker }: { broker?: string } = {},
): string {
  const hash = hex64();
  ledger.txs.set(hash, {
    hash,
    result: "tesSUCCESS",
    ledgerIndex: 4242,
    closeTime: CLOSE_TIME,
    transactionType: "NFTokenAcceptOffer",
    account: broker ?? buyer,
    nftokenId: offer.nftokenId,
    offerIndex: null,
    acceptedSellOfferIndex: offer.offerIndex,
  });
  ledger.owners.set(offer.nftokenId, buyer);
  return hash;
}

beforeEach(async () => {
  ledger.reset();
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("recording a validated primary sale", () => {
  it("marks the right NFT and offer sold and stores the buyer and tx details", async () => {
    const { event, offers } = await listedEvent();
    const hash = acceptOnLedger(offers[0]!);

    const result = await reconcileLedgerTransaction(deps, hash);
    expect(result).toEqual({
      outcome: "APPLIED",
      kind: "PRIMARY_SALE",
      offerId: offers[0]!.id,
      ticketId: offers[0]!.ticketId,
      acceptedByAddress: BUYER,
    });

    const offer = await db.nFTOffer.findUniqueOrThrow({ where: { id: offers[0]!.id } });
    expect(offer).toMatchObject({ state: "ACCEPTED", acceptTxHash: hash, acceptedByAddress: BUYER });
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: offers[0]!.ticketId! } });
    expect(ticket).toMatchObject({
      primarySaleTxHash: hash,
      cachedOwnerAddress: BUYER,
      ownerSyncStatus: "SYNCED",
      ownerSyncLedgerIndex: 4242,
    });
    expect(ticket.primarySoldAt?.toISOString()).toBe(CLOSE_TIME);
    const recorded = await db.ledgerTransaction.findUniqueOrThrow({ where: { hash } });
    expect(recorded).toMatchObject({ status: "VALIDATED_SUCCESS", account: BUYER, relatedOfferId: offers[0]!.id });
    expect(recorded.appliedAt).not.toBeNull();

    // The other ticket is untouched, and inventory reflects exactly one sale.
    const other = await db.ticketNFT.findUniqueOrThrow({ where: { id: offers[1]!.ticketId! } });
    expect(other.primarySoldAt).toBeNull();
    expect(await getPrimaryAvailability(db, event.id)).toMatchObject({ sold: 1, remaining: 1, isSoldOut: false });
  });

  it("does not count a sale twice for repeated or concurrent callbacks", async () => {
    const { event, offers } = await listedEvent();
    const first = acceptOnLedger(offers[0]!);
    expect((await reconcileLedgerTransaction(deps, first)).outcome).toBe("APPLIED");
    expect((await reconcileLedgerTransaction(deps, first)).outcome).toBe("ALREADY_APPLIED");

    const second = acceptOnLedger(offers[1]!);
    const outcomes = (await Promise.all([1, 2, 3].map(() => reconcileLedgerTransaction(deps, second)))).map(
      (r) => r.outcome,
    );
    expect(outcomes.sort()).toEqual(["ALREADY_APPLIED", "ALREADY_APPLIED", "APPLIED"]);

    expect(await db.ledgerTransaction.count({ where: { hash: second } })).toBe(1);
    expect(await getPrimaryAvailability(db, event.id)).toMatchObject({ sold: 2, remaining: 0, isSoldOut: true });
  });

  it("refuses to record anything the ledger hasn't validated", async () => {
    const { event, offers } = await listedEvent();
    const hash = acceptOnLedger(offers[0]!);
    ledger.pending.add(hash);
    await expect(reconcileLedgerTransaction(deps, hash)).rejects.toMatchObject({ code: "NOT_VALIDATED" });
    expect(await db.ledgerTransaction.count()).toBe(0);
    expect((await getPrimaryAvailability(db, event.id)).sold).toBe(0);
  });

  it("ignores transactions that aren't primary sales of this app's offers", async () => {
    const { offers } = await listedEvent(1);
    const mint = hex64();
    ledger.txs.set(mint, {
      hash: mint, result: "tesSUCCESS", ledgerIndex: 1, closeTime: null, transactionType: "NFTokenMint",
      account: SELLER_WALLET, nftokenId: offers[0]!.nftokenId, offerIndex: null, acceptedSellOfferIndex: null,
    });
    expect(await reconcileLedgerTransaction(deps, mint)).toEqual({ outcome: "NOT_APPLICABLE", reason: "NOT_AN_ACCEPT" });

    const foreign = acceptOnLedger({ offerIndex: hex64(), nftokenId: hex64() });
    expect(await reconcileLedgerTransaction(deps, foreign)).toEqual({ outcome: "NOT_APPLICABLE", reason: "UNKNOWN_OFFER" });

    // The NFT's holder accepting someone's buy offer took no sell offer, so none of the app's.
    const buyOfferTaken = acceptOnLedger({ offerIndex: null, nftokenId: offers[0]!.nftokenId }, SELLER_WALLET);
    expect(await reconcileLedgerTransaction(deps, buyOfferTaken)).toEqual({
      outcome: "NOT_APPLICABLE",
      reason: "UNKNOWN_OFFER",
    });

    await db.nFTOffer.update({ where: { id: offers[0]!.id }, data: { kind: "RESALE" } });
    const resale = acceptOnLedger(offers[0]!);
    expect(await reconcileLedgerTransaction(deps, resale)).toEqual({ outcome: "NOT_APPLICABLE", reason: "NOT_PRIMARY" });
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("refuses a transaction that moved a different NFT than the offer", async () => {
    const { offers } = await listedEvent(1);
    const hash = acceptOnLedger({ offerIndex: offers[0]!.offerIndex, nftokenId: hex64() });
    await expect(reconcileLedgerTransaction(deps, hash)).rejects.toMatchObject({ status: 409 });
  });

  it("records a brokered sale without guessing the new owner", async () => {
    const { event, offers } = await listedEvent(1);
    const BROKER = "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo";
    const hash = acceptOnLedger(offers[0]!, BUYER, { broker: BROKER });

    expect(await reconcileLedgerTransaction(deps, hash)).toMatchObject({ outcome: "APPLIED", acceptedByAddress: BROKER });
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: offers[0]!.id } })).toMatchObject({
      state: "ACCEPTED",
      acceptedByAddress: BROKER,
    });
    // The broker doesn't hold the NFT, so the owner is left for the next ownership sync.
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: offers[0]!.ticketId! } })).toMatchObject({
      primarySaleTxHash: hash,
      cachedOwnerAddress: null,
      ownerSyncStatus: "STALE",
    });
    expect(await getPrimaryAvailability(db, event.id)).toMatchObject({ sold: 1, isSoldOut: true });
  });
});

describe("working with Agent B's in-app purchase flow (XRPL-031)", () => {
  /** The buyer's in-app purchase attempt, before the app has learned its tx hash. */
  const attemptFor = (offer: { id: string; ticketId: string | null }) =>
    db.ledgerTransaction.create({
      data: {
        type: "NFTokenAcceptOffer",
        status: "PENDING",
        account: BUYER,
        relatedOfferId: offer.id,
        relatedTicketId: offer.ticketId,
        signRequestRef: "6f1c1f3e-2b8a-4d6c-9a51-1f8f0d2b7c11",
      },
    });

  const bDeps = (hash: string) => ({
    db,
    transactions: () => ({
      create: async () => {
        throw new Error("not used");
      },
      get: async () => ({ status: "CONFIRMED", txHash: hash }) as never,
    }),
    ledger: () => ({ ...fakeLedger, getOffers: async () => ({ sellOffers: [], buyOffers: [] }) as never }) as never,
  });

  it("reconcile first: claims the buyer's attempt, so the in-app flow then records nothing more", async () => {
    const { event, offers } = await listedEvent();
    const attempt = await attemptFor(offers[0]!);
    const hash = acceptOnLedger(offers[0]!);

    expect((await reconcileLedgerTransaction(deps, hash)).outcome).toBe("APPLIED");
    const claimed = await db.ledgerTransaction.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(claimed).toMatchObject({ hash, status: "VALIDATED_SUCCESS" });
    expect(await db.ledgerTransaction.count()).toBe(1);

    await reconcilePurchase(bDeps(hash), claimed);
    expect(await getPrimaryAvailability(db, event.id)).toMatchObject({ sold: 1 });
  });

  it("in-app flow first: the sale stores its tx hash, and a later callback is a no-op", async () => {
    const { event, offers } = await listedEvent();
    const attempt = await attemptFor(offers[0]!);
    const hash = acceptOnLedger(offers[0]!);

    await reconcilePurchase(bDeps(hash), attempt);
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: offers[0]!.ticketId! } });
    expect(ticket.primarySaleTxHash).toBe(hash);

    expect((await reconcileLedgerTransaction(deps, hash)).outcome).toBe("ALREADY_APPLIED");
    expect(await getPrimaryAvailability(db, event.id)).toMatchObject({ sold: 1 });
  });

  it("fills in the sale hash for a sale recorded before it was stored", async () => {
    const { offers } = await listedEvent(1);
    const hash = acceptOnLedger(offers[0]!);
    await db.ticketNFT.update({ where: { id: offers[0]!.ticketId! }, data: { primarySoldAt: new Date() } });
    await db.ledgerTransaction.create({
      data: { hash, type: "NFTokenAcceptOffer", status: "VALIDATED_SUCCESS", appliedAt: new Date(), relatedOfferId: offers[0]!.id },
    });

    expect((await reconcileLedgerTransaction(deps, hash)).outcome).toBe("ALREADY_APPLIED");
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: offers[0]!.ticketId! } })).primarySaleTxHash).toBe(hash);
  });
});

describe("sold-out status after sales (with Agent D's ResalePolicy)", () => {
  it("opens resale only once the last validated sale is recorded", async () => {
    const { event, offers } = await listedEvent(2);
    const policy = new ResalePolicy({
      events: {
        getEvent: async (id) => {
          const row = await db.event.findUnique({ where: { id } });
          return row && { id: row.id, status: row.status, startsAt: row.startsAt.toISOString(), endsAt: null };
        },
      },
      inventory: createInventoryPort(db),
      offers: { listResaleOffers: async () => [] },
    });

    await reconcileLedgerTransaction(deps, acceptOnLedger(offers[0]!));
    expect((await policy.getEligibility(event.id)).reasonCode).toBe("PRIMARY_STILL_ON_SALE");
    await reconcileLedgerTransaction(deps, acceptOnLedger(offers[1]!, "rUn84CUYbNjRoTQ6mSW7BVJPSVJNLb1QLo"));
    expect((await policy.getEligibility(event.id)).reasonCode).toBe("PRIMARY_SOLD_OUT");
  });
});

describe("POST /api/ledger/transactions/:hash/reconcile", () => {
  const ORIGIN = "http://localhost:3000";
  const post = (hash: string, cookie?: string) =>
    reconcilePOST(
      new Request(`${ORIGIN}/api/ledger/transactions/${hash}/reconcile`, {
        method: "POST",
        headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      }),
      { params: Promise.resolve({ hash }) },
    );

  it("needs a session, validates the hash, and reports what it applied", async () => {
    const { seller, offers } = await listedEvent(1);
    const hash = acceptOnLedger(offers[0]!);
    const cookie = `${sessionCookieName()}=${(await createSession(db, seller.id, "ONBOARDING")).token}`;

    expect((await post(hash)).status).toBe(401);
    expect((await post("not-a-hash", cookie)).status).toBe(400);

    const res = await post(hash, cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ outcome: "APPLIED", acceptedByAddress: BUYER });
    expect((await (await post(hash, cookie)).json()).data.outcome).toBe("ALREADY_APPLIED");
  });

  it("asks the caller to retry while the transaction isn't validated", async () => {
    const { seller, offers } = await listedEvent(1);
    const hash = acceptOnLedger(offers[0]!);
    ledger.pending.add(hash);
    const cookie = `${sessionCookieName()}=${(await createSession(db, seller.id, "ONBOARDING")).token}`;
    const res = await post(hash, cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "LEDGER_TX_NOT_VALIDATED", details: { retryable: true } });
  });
});
