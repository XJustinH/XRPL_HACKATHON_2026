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

import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import {
  getEventPrimaryOffers,
  listPrimaryOffers,
  OFFER_MEMO_TYPE,
  reconcileEventPrimaryOffers,
  reconcilePrimaryOffer,
  requestPrimaryOffer,
  UNSIGNABLE_AFTER_MS,
  type OfferDeps,
} from "./primary";

/** XRPL-029 primary sale offers against Postgres (`npm run test:db`), with Xaman and the ledger faked. */

const db = getDb();
const SELLER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const REQUEST_ID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

let serials = 0;
async function seed(options: { priceDrops?: string; status?: "DRAFT" | "PUBLISHED" } = {}) {
  const seller = await db.user.create({
    data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() },
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
    data: { eventId: event.id, name: "GA", priceDrops: options.priceDrops ?? "2500000", totalSupply: 10 },
  });
  const minted = (extra: { primarySoldAt?: Date } = {}) => {
    serials += 1;
    return db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial: serials,
        issuerAddress: SELLER,
        mintStatus: "MINTED",
        nftokenId: nftokenIdFor(SELLER, 7, serials),
        mintTxHash: TX_HASH.slice(0, 60) + String(serials).padStart(4, "0"),
        mintedAt: new Date(),
        ...extra,
      },
    });
  };
  return { seller, event, tier, minted };
}

function session(userId: string, walletAddress: string | null = SELLER): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role: "SELLER",
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
    id: REQUEST_ID,
    purpose: "CREATE_PRIMARY_OFFER",
    reference: null,
    status,
    transactionType: "NFTokenCreateOffer",
    account: SELLER,
    instruction: "Sell",
    signUrl: `https://xumm.app/sign/${REQUEST_ID}`,
    qrPngUrl: `https://xumm.app/sign/${REQUEST_ID}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

interface LedgerState {
  request: TransactionRequest;
  holds?: boolean;
  /** Sell offers on the ledger for the NFT. */
  sellOffers?: Array<{ offerIndex: string; owner: string; amountDrops: string; destination?: string | null }>;
}

function deps(state: LedgerState) {
  // Like Xaman, every request gets its own ID (the first one is REQUEST_ID).
  let created = 0;
  const create = vi.fn(async (input: { reference?: string | null }) => ({
    ...state.request,
    id: created++ === 0 ? REQUEST_ID : randomUUID(),
    reference: input.reference ?? null,
  }));
  const get = vi.fn(async () => state.request);
  const getValidatedTx = vi.fn(async (hash: string): Promise<ConfirmedLedgerTx> => ({
    hash,
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 1234,
    closeTime: "2026-11-20T19:00:00.000Z",
    transactionType: "NFTokenCreateOffer",
    account: SELLER,
    nftokenId: null,
    offerIndex: OFFER_INDEX,
    acceptedSellOfferIndex: null,
    explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
  }));
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: state.holds ?? true,
    nft: null,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 1235,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const getOffers = vi.fn(async (nftokenId: string): Promise<LedgerNftOffers> => ({
    nftokenId,
    sellOffers: (state.sellOffers ?? []).map((o) => ({
      offerIndex: o.offerIndex,
      nftokenId,
      side: "SELL",
      owner: o.owner,
      amountDrops: o.amountDrops,
      amountIssued: null,
      destination: o.destination ?? null,
      expiresAt: null,
      flags: 1,
    })),
    buyOffers: [],
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 1236,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const offerDeps: OfferDeps = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org" },
  };
  return { offerDeps, create, get, getValidatedTx, getOffers };
}

describe("requestPrimaryOffer", () => {
  it("lists a minted ticket at its tier price with a sell offer the seller signs", async () => {
    const { seller, minted } = await seed();
    const ticket = await minted();
    const { offerDeps, create } = deps({ request: txRequest("PENDING") });

    const { offer, request } = await requestPrimaryOffer(offerDeps, {
      session: session(seller.id),
      ticketId: ticket.id,
    });
    expect(offer).toMatchObject({
      kind: "PRIMARY",
      state: "PENDING_SIGNATURE",
      amountDrops: "2500000",
      ownerAddress: SELLER,
      nftokenId: ticket.nftokenId,
      offerIndex: null,
    });
    expect(request.id).toBe(REQUEST_ID);

    const [input] = create.mock.calls[0] as unknown as [
      { purpose: string; reference: string; txjson: Record<string, unknown>; instruction: string },
    ];
    expect(input.purpose).toBe("CREATE_PRIMARY_OFFER");
    expect(input.reference).toBe(offer.id);
    expect(input.txjson).toMatchObject({
      TransactionType: "NFTokenCreateOffer",
      Account: SELLER,
      NFTokenID: ticket.nftokenId,
      Amount: "2500000",
      Flags: 1, // tfSellNFToken, no Destination: anyone may buy
    });
    expect(input.txjson.Destination).toBeUndefined();
    const memo = (input.txjson.Memos as Array<{ Memo: { MemoType: string; MemoData: string } }>)[0]!.Memo;
    expect(convertHexToString(memo.MemoType)).toBe(OFFER_MEMO_TYPE);
    expect(convertHexToString(memo.MemoData)).toBe(offer.id);
    expect(input.instruction).toContain("for 2.5 XRP");

    expect(await db.ledgerTransaction.findFirstOrThrow()).toMatchObject({
      type: "NFTokenCreateOffer",
      status: "PENDING",
      signRequestRef: REQUEST_ID,
      relatedTicketId: ticket.id,
      relatedOfferId: offer.id,
    });
  });

  it("refuses tickets the seller cannot list", async () => {
    const { seller, event, tier, minted } = await seed();
    const sold = await minted({ primarySoldAt: new Date() });
    const unminted = await db.ticketNFT.create({
      data: { eventId: event.id, tierId: tier.id, serial: 999, issuerAddress: SELLER, mintStatus: "PENDING" },
    });
    const held = await minted();
    const other = await db.user.create({
      data: { displayName: "Other", role: "SELLER", onboardedAt: new Date() },
    });
    const { offerDeps, create } = deps({ request: txRequest("PENDING"), holds: false });
    const attempt = (who: AuthSession, ticketId: string) =>
      requestPrimaryOffer(offerDeps, { session: who, ticketId });

    await expect(attempt(session(seller.id), unminted.id)).rejects.toMatchObject({ status: 409 });
    await expect(attempt(session(seller.id), sold.id)).rejects.toMatchObject({ status: 409 });
    await expect(attempt(session(seller.id), held.id)).rejects.toThrow(/does not hold/); // wallet gave it away
    await expect(attempt(session(seller.id, null), held.id)).rejects.toMatchObject({
      status: 403,
      code: "WALLET_NOT_VERIFIED",
    });
    await expect(attempt(session(other.id), held.id)).rejects.toMatchObject({
      status: 403,
      code: "NOT_EVENT_OWNER",
    });
    await expect(attempt(session(seller.id), "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f")).rejects.toMatchObject({
      status: 404,
    });
    expect(create).not.toHaveBeenCalled();
    expect(await db.nFTOffer.count()).toBe(0);
  });

  it("refuses a tier without a price", async () => {
    const { seller, minted } = await seed({ priceDrops: "0" });
    const ticket = await minted();
    const { offerDeps } = deps({ request: txRequest("PENDING") });
    await expect(
      requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id }),
    ).rejects.toThrow(/price above 0 XRP/);
  });

  it("keeps one live offer per ticket, even under concurrent requests", async () => {
    const { seller, minted } = await seed();
    const ticket = await minted();
    const { offerDeps } = deps({ request: txRequest("PENDING") });
    const attempt = () =>
      requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id });

    const results = await Promise.allSettled([attempt(), attempt(), attempt(), attempt()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    await expect(attempt()).rejects.toThrow("This ticket is already being listed");
    expect(await db.nFTOffer.count()).toBe(1);
  });

  it("frees the ticket when the wallet service is down", async () => {
    const { seller, minted } = await seed();
    const ticket = await minted();
    const { offerDeps, create } = deps({ request: txRequest("PENDING") });
    create.mockRejectedValueOnce(new Error("Xaman down"));
    const attempt = () =>
      requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id });

    await expect(attempt()).rejects.toThrow("Xaman down");
    expect((await db.nFTOffer.findFirstOrThrow()).state).toBe("FAILED");
    expect((await attempt()).offer.state).toBe("PENDING_SIGNATURE");
  });
});

describe("reconcilePrimaryOffer", () => {
  async function listed(state: LedgerState) {
    const seeded = await seed();
    const ticket = await seeded.minted();
    const d = deps(state);
    const { offer } = await requestPrimaryOffer(d.offerDeps, {
      session: session(seeded.seller.id),
      ticketId: ticket.id,
    });
    return { ...seeded, ...d, ticket, offer };
  }

  it("activates the offer from the validated transaction, exactly once", async () => {
    const state: LedgerState = { request: txRequest("PENDING") };
    const { offerDeps, offer } = await listed(state);
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH, engineResult: "tesSUCCESS" });
    state.sellOffers = [{ offerIndex: OFFER_INDEX, owner: SELLER, amountDrops: "2500000" }];

    expect(await reconcilePrimaryOffer(offerDeps, offer.id)).toMatchObject({
      state: "ACTIVE",
      offerIndex: OFFER_INDEX,
      createTxHash: TX_HASH,
    });
    await reconcilePrimaryOffer(offerDeps, offer.id); // replay: no second effect
    expect(await db.ledgerTransaction.findMany()).toEqual([
      expect.objectContaining({ hash: TX_HASH, status: "VALIDATED_SUCCESS", appliedAt: expect.any(Date) }),
    ]);
  });

  it("records an offer already taken off the ledger as stale", async () => {
    const state: LedgerState = { request: txRequest("PENDING") };
    const { offerDeps, offer } = await listed(state);
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH });
    state.sellOffers = [];

    expect((await reconcilePrimaryOffer(offerDeps, offer.id)).state).toBe("STALE");
  });

  it("refuses an on-ledger offer that is not the one requested", async () => {
    const state: LedgerState = { request: txRequest("PENDING") };
    const { offerDeps, offer } = await listed(state);
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH });
    state.sellOffers = [{ offerIndex: OFFER_INDEX, owner: SELLER, amountDrops: "1" }];

    await expect(reconcilePrimaryOffer(offerDeps, offer.id)).rejects.toThrow(/does not match/);
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe(
      "PENDING_SIGNATURE",
    );
  });

  it.each([
    ["REJECTED", {}, "DROPPED"],
    ["EXPIRED", {}, "DROPPED"],
    [
      "FAILED",
      { failureReason: "LEDGER_REJECTED", engineResult: "tecNO_PERMISSION", txHash: TX_HASH },
      "VALIDATED_FAILURE",
    ],
  ] as const)("marks a %s listing FAILED and frees the ticket", async (status, extra, ledgerStatus) => {
    const state: LedgerState = { request: txRequest("PENDING") };
    const { offerDeps, offer, seller, ticket } = await listed(state);
    state.request = txRequest(status, extra);

    expect((await reconcilePrimaryOffer(offerDeps, offer.id)).state).toBe("FAILED");
    expect((await db.ledgerTransaction.findFirstOrThrow()).status).toBe(ledgerStatus);
    // The ticket can be listed again.
    state.request = txRequest("PENDING");
    expect(
      (await requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id })).offer
        .state,
    ).toBe("PENDING_SIGNATURE");
  });
});

describe("primary offers whose request was never recorded", () => {
  it("are released once a request would have expired, so the ticket can be listed again", async () => {
    const { seller, event, minted } = await seed();
    const ticket = await minted();
    const row = (createdAt: Date) =>
      db.nFTOffer.create({
        data: {
          ticketId: ticket.id,
          nftokenId: ticket.nftokenId as string,
          kind: "PRIMARY",
          state: "PENDING_SIGNATURE",
          ownerAddress: SELLER,
          amountDrops: "2500000",
          createdByUserId: seller.id,
          createdAt,
        },
      });
    const orphan = await row(new Date(Date.now() - UNSIGNABLE_AFTER_MS - 60_000));
    const { offerDeps } = deps({ request: txRequest("PENDING") });

    await expect(
      requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id }),
    ).rejects.toThrow("This ticket is already being listed");
    await reconcileEventPrimaryOffers(offerDeps, event.id);
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: orphan.id } })).state).toBe("FAILED");
    expect(
      (await requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id })).offer
        .state,
    ).toBe("PENDING_SIGNATURE");
  });
});

describe("listing primary offers", () => {
  async function activeOffer(
    ticket: { id: string; nftokenId: string | null },
    amountDrops: string,
    extra = {},
  ) {
    serials += 1;
    return db.nFTOffer.create({
      data: {
        ticketId: ticket.id,
        nftokenId: ticket.nftokenId as string,
        kind: "PRIMARY",
        state: "ACTIVE",
        ownerAddress: SELLER,
        amountDrops,
        offerIndex: OFFER_INDEX.slice(0, 60) + String(serials).padStart(4, "0"),
        ...extra,
      },
    });
  }

  it("lists live offers on unsold tickets, cheapest first", async () => {
    const { event, minted } = await seed();
    const [a, b, c, sold, expired, cancelled] = await Promise.all([
      minted(),
      minted(),
      minted(),
      minted({ primarySoldAt: new Date() }),
      minted(),
      minted(),
    ]);
    await activeOffer(a, "10000000");
    await activeOffer(b, "9000000"); // cheaper as a number, not as text
    await activeOffer(c, "10000000");
    await activeOffer(sold, "1000000");
    await activeOffer(expired, "1000000", { expiresAt: new Date(Date.now() - 1000) });
    await activeOffer(cancelled, "1000000", { state: "CANCELLED" });
    const other = await seed();
    await activeOffer(await other.minted(), "1");

    const offers = await listPrimaryOffers(db, event.id);
    expect(offers.map((o) => [o.ticketId, o.amountDrops])).toEqual([
      [b.id, "9000000"],
      [a.id, "10000000"],
      [c.id, "10000000"],
    ]);
    expect(offers[0]).toMatchObject({
      sellerAddress: SELLER,
      tierName: "GA",
      serial: b.serial,
      nftokenId: b.nftokenId,
    });
  });

  it("hides a draft's offers from everyone but its owner, whose read reconciles first", async () => {
    const { seller, event, minted } = await seed({ status: "DRAFT" });
    const ticket = await minted();
    const state: LedgerState = { request: txRequest("PENDING") };
    const { offerDeps } = deps(state);
    await requestPrimaryOffer(offerDeps, { session: session(seller.id), ticketId: ticket.id });
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH });
    state.sellOffers = [{ offerIndex: OFFER_INDEX, owner: SELLER, amountDrops: "2500000" }];

    await expect(
      getEventPrimaryOffers(offerDeps, { session: null, eventId: event.id }),
    ).rejects.toMatchObject({
      status: 404,
    });
    const owned = await getEventPrimaryOffers(offerDeps, { session: session(seller.id), eventId: event.id });
    expect(owned).toEqual([expect.objectContaining({ ticketId: ticket.id, offerIndex: OFFER_INDEX })]);
  });
});
