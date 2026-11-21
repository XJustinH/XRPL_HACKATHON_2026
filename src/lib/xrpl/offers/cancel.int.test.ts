import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConfirmedLedgerTx,
  LedgerNftOffer,
  TransactionFailureReason,
  TransactionRequest,
  TransactionRequestStatus,
} from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import { requestOfferCancellation } from "./cancel";
import { requestHolderOffer } from "./holder";
import { syncOfferWithLedger } from "./ledger-check";
import type { OfferDeps } from "./primary";
import { getOfferStatus } from "./purchase";

/**
 * Cancelling offers and cleaning up stale ones (XRPL-042), against Postgres (`npm run test:db`)
 * with Xaman and the ledger faked.
 */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOLDER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const NFT = nftokenIdFor(ISSUER, 9, 1);
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const hash = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");
const CANCEL_TX = hash(77);

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

function session(userId: string, walletAddress: string | null): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role: "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress,
    walletVerifiedAt: walletAddress ? new Date() : null,
  };
}

function ledgerOffer(o: Partial<LedgerNftOffer> = {}): LedgerNftOffer {
  return {
    offerIndex: OFFER_INDEX,
    nftokenId: NFT,
    side: "SELL",
    owner: HOLDER,
    amountDrops: "3000000",
    amountIssued: null,
    destination: null,
    expiresAt: null,
    flags: 1,
    ...o,
  } as LedgerNftOffer;
}

/** A held ticket with an ACTIVE resale offer for it, recorded from the ledger. */
async function seed(kind: "RESALE" | "GIFT" = "RESALE") {
  const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
  const holder = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2099-03-12T20:00:00Z"), venue: "Rooms", city: "Dublin", status: "PUBLISHED" },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 1, mintedQuantity: 1 },
  });
  const ticket = await db.ticketNFT.create({
    data: {
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
      issuerAddress: ISSUER,
      mintStatus: "MINTED",
      nftokenId: NFT,
      mintTxHash: hash(1),
      mintedAt: new Date(),
      primarySoldAt: new Date(),
      cachedOwnerAddress: HOLDER,
    },
  });
  const offer = await db.nFTOffer.create({
    data: {
      ticketId: ticket.id,
      nftokenId: NFT,
      kind,
      state: "ACTIVE",
      ownerAddress: HOLDER,
      destinationAddress: kind === "GIFT" ? FRIEND : null,
      amountDrops: kind === "GIFT" ? "0" : "3000000",
      offerIndex: OFFER_INDEX,
      createTxHash: hash(2),
    },
  });
  return { holder, ticket, offer };
}

interface World {
  /** Who holds the NFT on the ledger. */
  holder: string;
  /** Live sell offers on the ledger. */
  sellOffers: LedgerNftOffer[];
  /** What the wallet request reports. */
  status: TransactionRequestStatus;
  failureReason?: TransactionFailureReason | null;
  confirmed?: Partial<ConfirmedLedgerTx>;
}

function deps(world: World) {
  const create = vi.fn(
    async (input: { purpose: string; reference?: string | null }): Promise<TransactionRequest> => ({
      id: randomUUID(),
      purpose: input.purpose as TransactionRequest["purpose"],
      reference: input.reference ?? null,
      status: "PENDING",
      transactionType: "NFTokenCancelOffer",
      account: HOLDER,
      instruction: "x",
      signUrl: "https://xumm.app/sign/x",
      qrPngUrl: "https://xumm.app/sign/x_q.png",
      expiresAt: null,
      txHash: null,
      engineResult: null,
      ledgerIndex: null,
      explorerUrl: null,
      failureReason: null,
    }),
  );
  const get = vi.fn(
    async (id: string): Promise<TransactionRequest> => ({
      id,
      purpose: "CANCEL_OFFER",
      reference: null,
      status: world.status,
      transactionType: "NFTokenCancelOffer",
      account: HOLDER,
      instruction: "x",
      signUrl: "https://xumm.app/sign/x",
      qrPngUrl: "https://xumm.app/sign/x_q.png",
      expiresAt: null,
      txHash: world.status === "CONFIRMED" || world.status === "FAILED" ? CANCEL_TX : null,
      engineResult: world.status === "FAILED" ? "tecNO_ENTRY" : null,
      ledgerIndex: null,
      explorerUrl: null,
      failureReason: world.failureReason ?? null,
    }),
  );
  const provenance = { endpoint: "wss://node", ledgerIndex: 3000, ledgerHash: null, validated: true, fetchedAt: "" };
  const getValidatedTx = vi.fn(
    async (h: string): Promise<ConfirmedLedgerTx> => ({
      hash: h,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: 3001,
      closeTime: "2026-11-21T10:00:00.000Z",
      transactionType: "NFTokenCancelOffer",
      account: HOLDER,
      nftokenId: null,
      offerIndex: null,
      acceptedSellOfferIndex: null,
      explorerUrl: `https://testnet.xrpl.org/transactions/${h}`,
      ...world.confirmed,
    }),
  );
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.holder === address,
    nft: null,
    provenance,
  }));
  const getOffers = vi.fn(async (nftokenId: string) => ({ nftokenId, sellOffers: world.sellOffers, buyOffers: [], provenance }));
  const all = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" } as never,
  } satisfies OfferDeps;
  return { all, create };
}

const live = (): World => ({ holder: HOLDER, sellOffers: [ledgerOffer()], status: "PENDING" });
type CreateInput = { purpose: string; instruction: string; txjson: Record<string, unknown>; reference: string };

describe("requestOfferCancellation", () => {
  it("asks the owner's wallet to cancel the offer, which stays open until that validates", async () => {
    const { holder, offer } = await seed();
    const { all, create } = deps(live());

    const result = await requestOfferCancellation(all, { session: session(holder.id, HOLDER), offerId: offer.id });

    expect(result.offer).toMatchObject({ id: offer.id, state: "ACTIVE" });
    const input = (create.mock.calls[0] as unknown as [CreateInput])[0];
    expect(input.purpose).toBe("CANCEL_OFFER");
    expect(input.reference).toBe(offer.id);
    expect(input.instruction).toBe("Cancel resale listing: Gig — GA #1 at 3 XRP");
    expect(input.txjson).toMatchObject({ TransactionType: "NFTokenCancelOffer", Account: HOLDER, NFTokenOffers: [OFFER_INDEX] });
    const attempt = await db.ledgerTransaction.findFirstOrThrow({ where: { relatedOfferId: offer.id } });
    expect(attempt).toMatchObject({ type: "NFTokenCancelOffer", status: "PENDING", account: HOLDER, signRequestRef: result.request.id });
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("ACTIVE");
  });

  it("is only for the offer's owner, and only while it's open", async () => {
    const { holder, offer } = await seed("GIFT");
    const { all, create } = deps(live());

    // Anyone else, including the gift's recipient, can't see it here.
    await expect(requestOfferCancellation(all, { session: session(holder.id, FRIEND), offerId: offer.id })).rejects.toMatchObject({ status: 404 });
    await expect(requestOfferCancellation(all, { session: session(holder.id, null), offerId: offer.id })).rejects.toMatchObject({ status: 403 });

    await db.nFTOffer.update({ where: { id: offer.id }, data: { state: "ACCEPTED" } });
    await expect(requestOfferCancellation(all, { session: session(holder.id, HOLDER), offerId: offer.id })).rejects.toThrow("no longer open");
    expect(create).not.toHaveBeenCalled();
  });

  it("allows one cancellation in flight, and another once that was declined", async () => {
    const { holder, offer } = await seed();
    const world = live();
    const { all, create } = deps(world);
    const cancel = () => requestOfferCancellation(all, { session: session(holder.id, HOLDER), offerId: offer.id });

    await cancel();
    await expect(cancel()).rejects.toThrow("already waiting for your approval");

    world.status = "REJECTED";
    await cancel();
    expect(create).toHaveBeenCalledTimes(2);
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("ACTIVE");
  });

  it("records an offer already gone from the ledger instead of asking to sign", async () => {
    const { holder, offer } = await seed();
    const { all, create } = deps({ ...live(), sellOffers: [] });

    await expect(requestOfferCancellation(all, { session: session(holder.id, HOLDER), offerId: offer.id })).rejects.toThrow(
      "no longer on the XRP Ledger",
    );
    expect(create).not.toHaveBeenCalled();
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("STALE");
  });
});

describe("recording a cancellation", () => {
  async function cancelled(world: World) {
    const seeded = await seed();
    const d = deps(world);
    await requestOfferCancellation(d.all, { session: session(seeded.holder.id, HOLDER), offerId: seeded.offer.id });
    return { ...seeded, ...d };
  }

  it("marks the offer cancelled only from the validated transaction, once it's gone from the ledger", async () => {
    const world = live();
    const { holder, offer, ticket, all } = await cancelled(world);

    // Signed and sent, but not validated yet: still open.
    world.status = "SUBMITTED";
    expect((await getOfferStatus(all, offer.id)).offer.state).toBe("ACTIVE");

    world.status = "CONFIRMED";
    world.sellOffers = [];
    expect((await getOfferStatus(all, offer.id)).offer.state).toBe("CANCELLED");
    const row = await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.cancelTxHash).toBe(CANCEL_TX);
    expect(await db.ledgerTransaction.findFirstOrThrow({ where: { relatedOfferId: offer.id, type: "NFTokenCancelOffer" } })).toMatchObject({
      hash: CANCEL_TX,
      status: "VALIDATED_SUCCESS",
      appliedAt: expect.any(Date),
    });

    // The ticket can be offered again.
    await expect(
      requestHolderOffer(all, {
        session: session(holder.id, HOLDER),
        ticketId: ticket.id,
        offer: { kind: "GIFT", destination: FRIEND },
      }),
    ).resolves.toMatchObject({ offer: { state: "PENDING_SIGNATURE" } });
  });

  it("doesn't claim a cancellation the ledger doesn't show", async () => {
    const world = live();
    const { offer, all } = await cancelled(world);

    world.status = "CONFIRMED"; // ...but the offer is still on the ledger.
    expect((await getOfferStatus(all, offer.id)).offer.state).toBe("ACTIVE");
  });

  it("rejects a cancellation signed by another account", async () => {
    const world = live();
    const { offer, all } = await cancelled(world);

    world.status = "CONFIRMED";
    world.sellOffers = [];
    world.confirmed = { account: FRIEND };
    await expect(getOfferStatus(all, offer.id)).rejects.toThrow("was signed by");
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("ACTIVE");
  });

  it("closes the offer as stale when the ledger refused the cancellation because it was already gone", async () => {
    const world = live();
    const { offer, all } = await cancelled(world);

    world.status = "FAILED";
    world.failureReason = "LEDGER_REJECTED";
    world.sellOffers = [];
    expect((await getOfferStatus(all, offer.id)).offer.state).toBe("STALE");
  });
});

describe("syncOfferWithLedger", () => {
  it("closes offers the ledger no longer backs, and leaves live ones open", async () => {
    const { offer } = await seed();
    const world = live();
    const { all } = deps(world);

    expect(await syncOfferWithLedger(all, offer)).toBe("ACTIVE");
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).lastSyncedAt).toEqual(expect.any(Date));

    // The NFT moved elsewhere (e.g. sold on another marketplace): the offer can't complete.
    world.holder = FRIEND;
    expect(await syncOfferWithLedger(all, offer)).toBe("STALE");
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe("STALE");
  });

  it("expires offers past their expiry, and waits while a purchase or cancellation is in flight", async () => {
    const { offer } = await seed();
    const { all } = deps(live());

    await db.ledgerTransaction.create({
      data: { type: "NFTokenAcceptOffer", status: "PENDING", account: FRIEND, relatedOfferId: offer.id },
    });
    const expired = { ...offer, expiresAt: new Date("2020-01-01T00:00:00Z") };
    expect(await syncOfferWithLedger(all, expired)).toBe("ACTIVE");

    await db.ledgerTransaction.deleteMany();
    expect(await syncOfferWithLedger(all, expired)).toBe("EXPIRED");
  });
});
