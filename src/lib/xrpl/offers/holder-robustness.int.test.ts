import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AccountSummary,
  ConfirmedLedgerTx,
  LedgerNftOffers,
  TransactionRequest,
  TransactionRequestStatus,
} from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { XrplServiceError } from "../errors";
import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import { requestHolderOffer, type HolderOfferDeps } from "./holder";
import { reconcileOfferCreation, UNSIGNABLE_AFTER_MS } from "./primary";
import { getOfferStatus, type PurchaseDeps } from "./purchase";

/**
 * XRPL-036 robustness against Postgres (`npm run test:db`): settling a ticket's earlier offers before
 * a new one, the reserve a new offer needs, check-ins and earlier holders under the lock, offers stuck
 * awaiting approval, and an offer that validates after its ticket was checked in. Xaman and the ledger
 * are faked.
 */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const HOLDER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
const REQUEST_ID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const PRICE = "30000000"; // 30 XRP; face value is 2.5 XRP

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

let serials = 0;
/** One published event with a 2.5 XRP tier, and tickets sold through the primary sale. */
async function seed() {
  const seller = await db.user.create({
    data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() },
  });
  const fan = await db.user.create({
    data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig",
      startsAt: new Date("2099-03-12T20:00:00Z"),
      venue: "Rooms",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 5 },
  });
  const ticket = () => {
    serials += 1;
    return db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial: serials,
        issuerAddress: ISSUER,
        mintStatus: "MINTED",
        nftokenId: nftokenIdFor(ISSUER, 7, serials),
        mintTxHash: TX_HASH.slice(0, 60) + String(serials).padStart(4, "0"),
        mintedAt: new Date(),
        primarySoldAt: new Date("2026-11-20T18:00:00Z"),
      },
    });
  };
  const checkIn = (t: { id: string }) =>
    db.checkInRecord.create({
      data: { ticketId: t.id, eventId: event.id, organiserId: seller.id, walletAddress: HOLDER },
    });
  return { seller, fan, event, ticket, checkIn };
}

function session(userId: string, walletAddress: string = HOLDER): AuthSession {
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
    walletVerifiedAt: new Date(),
  };
}

function txRequest(
  status: TransactionRequestStatus,
  extra: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    id: REQUEST_ID,
    purpose: "CREATE_RESALE_OFFER",
    reference: null,
    status,
    transactionType: "NFTokenCreateOffer",
    account: HOLDER,
    instruction: "Resell",
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

const provenance = {
  endpoint: "wss://node",
  ledgerIndex: 1235,
  ledgerHash: null,
  validated: true,
  fetchedAt: "",
};

interface LedgerState {
  request: TransactionRequest;
  /** Who holds the NFT on the ledger. */
  owner?: string;
  sellOffers?: Array<{ offerIndex: string; owner: string; amountDrops: string; destination?: string | null }>;
  balanceDrops?: string;
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
    closeTime: "2026-11-21T10:00:00.000Z",
    transactionType: "NFTokenCreateOffer",
    account: HOLDER,
    nftokenId: null,
    offerIndex: OFFER_INDEX,
    acceptedSellOfferIndex: null,
    explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
  }));
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: address === (state.owner ?? HOLDER),
    nft: null,
    provenance,
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
    provenance,
  }));
  const getAccountInfo = vi.fn(async (address: string): Promise<AccountSummary> => ({
    address,
    exists: true,
    balanceDrops: state.balanceDrops ?? "50000000",
    sequence: 1,
    ownerCount: 2,
    provenance,
  }));
  const getReserves = vi.fn(async () => ({ baseDrops: "1000000", incrementDrops: "200000" }));
  const all = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers, getAccountInfo, getReserves }) as never,
    config: {
      network: "TESTNET",
      explorerUrl: "https://testnet.xrpl.org",
      networkLabel: "XRPL Testnet",
    } as never,
  } as HolderOfferDeps & PurchaseDeps;
  return { all, create, get, getOffers, getReserves, getValidatedTx };
}

const resell = (all: HolderOfferDeps, userId: string, ticketId: string, amountDrops = PRICE) =>
  requestHolderOffer(all, { session: session(userId), ticketId, offer: { kind: "RESALE", amountDrops } });

const stateOf = async (id: string) => (await db.nFTOffer.findUniqueOrThrow({ where: { id } })).state;

const confirmedOnLedger = (state: LedgerState) => {
  state.request = txRequest("CONFIRMED", { txHash: TX_HASH, engineResult: "tesSUCCESS" });
  state.sellOffers = [{ offerIndex: OFFER_INDEX, owner: HOLDER, amountDrops: PRICE }];
};

describe("settling a ticket's earlier offers before a new one", () => {
  it.each([
    ["REJECTED", {}],
    ["EXPIRED", {}],
    [
      "FAILED",
      { failureReason: "LEDGER_REJECTED", engineResult: "tecINSUFFICIENT_RESERVE", txHash: TX_HASH },
    ],
  ] as const)("frees the ticket after a %s listing, with no read in between", async (status, extra) => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const state: LedgerState = { request: txRequest("PENDING") };
    const { all } = deps(state);
    const { offer } = await resell(all, fan.id, sold.id);

    state.request = txRequest(status, extra);
    expect((await resell(all, fan.id, sold.id)).offer.state).toBe("PENDING_SIGNATURE");
    expect(await stateOf(offer.id)).toBe("FAILED");
  });

  it("frees the ticket once the holder's open offer has gone from the ledger", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const state: LedgerState = { request: txRequest("PENDING") };
    const { all } = deps(state);
    const { offer } = await resell(all, fan.id, sold.id);
    confirmedOnLedger(state);
    expect((await reconcileOfferCreation(all, offer.id)).state).toBe("ACTIVE");

    state.sellOffers = []; // cancelled with another wallet app
    state.request = txRequest("PENDING");
    expect((await resell(all, fan.id, sold.id)).offer.state).toBe("PENDING_SIGNATURE");
    expect(await stateOf(offer.id)).toBe("STALE");
  });
});

describe("the reserve a new offer needs", () => {
  it("refuses when the wallet can't cover the reserve the offer locks", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    // Reserve: 1 XRP base + 2 objects x 0.2 XRP = 1.4 XRP; only 0.1 XRP spare.
    const { all, create } = deps({ request: txRequest("PENDING"), balanceDrops: "1500000" });

    await expect(resell(all, fan.id, sold.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Not enough XRP to make this offer"),
      details: { spendableDrops: "100000" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("counts the wallet's other offers awaiting approval against its reserve, once settled", async () => {
    const { fan, ticket } = await seed();
    const [sold, other] = [await ticket(), await ticket()];
    // 0.25 XRP spare covers one offer (0.2 XRP plus the fee), not two.
    const state: LedgerState = { request: txRequest("PENDING"), balanceDrops: "1650000" };
    const { all, create } = deps(state);
    const waiting = await db.nFTOffer.create({
      data: {
        ticketId: other.id,
        nftokenId: other.nftokenId as string,
        kind: "RESALE",
        state: "PENDING_SIGNATURE",
        ownerAddress: HOLDER,
        amountDrops: PRICE,
        createdByUserId: fan.id,
      },
    });
    await db.ledgerTransaction.create({
      data: {
        type: "NFTokenCreateOffer",
        network: "TESTNET",
        account: HOLDER,
        status: "PENDING",
        signRequestRef: randomUUID(),
        relatedTicketId: other.id,
        relatedOfferId: waiting.id,
      },
    });

    await expect(resell(all, fan.id, sold.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("Your 1 other offer waiting for approval in Xaman will need it too."),
      details: { requiredDrops: "401000", spendableDrops: "250000" },
    });
    expect(create).not.toHaveBeenCalled();

    // Declined in Xaman a moment ago: settled first, so it doesn't count.
    state.request = txRequest("REJECTED");
    expect((await resell(all, fan.id, sold.id)).offer.state).toBe("PENDING_SIGNATURE");
    expect(await stateOf(waiting.id)).toBe("FAILED");
  });

  it("doesn't count offers whose request can't be signed any more, or this ticket's own", async () => {
    const { fan, ticket } = await seed();
    const [sold, other] = [await ticket(), await ticket()];
    // One offer's worth spare. The abandoned offer below matches one on the ledger, so settling can't
    // release it: only the cutoff keeps it out of the count.
    const { all } = deps({
      request: txRequest("PENDING"),
      balanceDrops: "1650000",
      sellOffers: [{ offerIndex: OFFER_INDEX, owner: HOLDER, amountDrops: PRICE }],
    });
    await db.nFTOffer.create({
      data: {
        ticketId: other.id,
        nftokenId: other.nftokenId as string,
        kind: "RESALE",
        state: "PENDING_SIGNATURE",
        ownerAddress: HOLDER,
        amountDrops: PRICE,
        createdByUserId: fan.id,
        createdAt: new Date(Date.now() - UNSIGNABLE_AFTER_MS - 60_000), // abandoned long ago, never re-read
      },
    });

    expect((await resell(all, fan.id, sold.id)).offer.state).toBe("PENDING_SIGNATURE");
    // This ticket's own open offer falls to the one-offer rule, not the reserve check.
    await expect(resell(all, fan.id, sold.id)).rejects.toThrow("already waiting for approval in Xaman");
  });
});

describe("check-ins and earlier holders, under the ticket's lock", () => {
  it("refuses a ticket checked in while the offer is being prepared", async () => {
    const { fan, ticket, checkIn } = await seed();
    const sold = await ticket();
    const { all, create, getReserves } = deps({ request: txRequest("PENDING") });
    // The check-in lands after the first look, before the ticket row is locked.
    getReserves.mockImplementationOnce(async () => {
      await checkIn(sold);
      return { baseDrops: "1000000", incrementDrops: "200000" };
    });

    await expect(resell(all, fan.id, sold.id)).rejects.toThrow("already been used to enter the event");
    expect(create).not.toHaveBeenCalled();
    expect(await db.nFTOffer.count()).toBe(0);
  });

  it("lets a new holder offer the ticket while an earlier holder's listing still awaits approval", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const earlier = await db.nFTOffer.create({
      data: {
        ticketId: sold.id,
        nftokenId: sold.nftokenId as string,
        kind: "RESALE",
        state: "PENDING_SIGNATURE",
        ownerAddress: OTHER,
        amountDrops: "9000000",
      },
    });
    await db.ledgerTransaction.create({
      data: {
        type: "NFTokenCreateOffer",
        network: "TESTNET",
        account: OTHER,
        status: "PENDING",
        signRequestRef: randomUUID(),
        relatedTicketId: sold.id,
        relatedOfferId: earlier.id,
      },
    });
    const { all } = deps({ request: txRequest("PENDING") }); // that request is still open

    expect((await resell(all, fan.id, sold.id)).offer.state).toBe("PENDING_SIGNATURE");
    expect(await stateOf(earlier.id)).toBe("PENDING_SIGNATURE"); // signing it now would fail on the ledger
  });

  it("retires an earlier holder's open offer under the lock, even when the ledger can't be read", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const earlier = await db.nFTOffer.create({
      data: {
        ticketId: sold.id,
        nftokenId: sold.nftokenId as string,
        kind: "RESALE",
        state: "ACTIVE",
        ownerAddress: OTHER,
        amountDrops: "9000000",
        offerIndex: OFFER_INDEX,
        createTxHash: TX_HASH,
      },
    });
    const { all, getOffers } = deps({ request: txRequest("PENDING") });
    getOffers.mockRejectedValue(new Error("node down")); // so settling before the lock can't retire it
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { offer } = await resell(all, fan.id, sold.id);
    spy.mockRestore();
    expect(offer.state).toBe("PENDING_SIGNATURE");
    expect(await stateOf(earlier.id)).toBe("STALE");
  });

  it("records an offer that validates after its ticket was checked in as STALE, never ACTIVE", async () => {
    const { fan, ticket, checkIn } = await seed();
    const sold = await ticket();
    const state: LedgerState = { request: txRequest("PENDING") };
    const { all } = deps(state);
    const { offer } = await resell(all, fan.id, sold.id);
    await checkIn(sold); // admitted at the gate while the listing awaited approval
    confirmedOnLedger(state);

    // Recorded through the offer's own status read, as the app's offer page does.
    expect((await getOfferStatus(all, offer.id)).offer).toMatchObject({
      state: "STALE",
      createTxHash: TX_HASH,
    });
  });
});

describe("offers whose request can't be signed or followed any more", () => {
  const longAgo = () => new Date(Date.now() - UNSIGNABLE_AFTER_MS - 60_000);

  async function awaitingApproval(
    t: { id: string; nftokenId: string | null },
    fanId: string,
    createdAt: Date,
  ) {
    return db.nFTOffer.create({
      data: {
        ticketId: t.id,
        nftokenId: t.nftokenId as string,
        kind: "RESALE",
        state: "PENDING_SIGNATURE",
        ownerAddress: HOLDER,
        amountDrops: PRICE,
        createdByUserId: fanId,
        createdAt,
      },
    });
  }
  function recordRequest(t: { id: string }, offerId: string, createdAt: Date, hash: string | null = null) {
    return db.ledgerTransaction.create({
      data: {
        type: "NFTokenCreateOffer",
        network: "TESTNET",
        account: HOLDER,
        status: "PENDING",
        signRequestRef: randomUUID(),
        hash,
        relatedTicketId: t.id,
        relatedOfferId: offerId,
        createdAt,
      },
    });
  }

  it("releases one whose request was never recorded, once a request would have expired", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const orphan = await awaitingApproval(sold, fan.id, longAgo());
    const recent = await awaitingApproval(sold, fan.id, new Date(Date.now() - 3 * 60 * 1000)); // may still be signed
    const open = await awaitingApproval(sold, fan.id, longAgo());
    await recordRequest(sold, open.id, longAgo());
    const { all } = deps({ request: txRequest("OPENED") });

    for (const o of [orphan, recent, open]) await reconcileOfferCreation(all, o.id);
    expect(await stateOf(orphan.id)).toBe("FAILED");
    expect(await stateOf(recent.id)).toBe("PENDING_SIGNATURE");
    expect(await stateOf(open.id)).toBe("PENDING_SIGNATURE"); // its request is recorded and still open
  });

  it("releases one whose unsigned request Xaman no longer has, unless its offer reached the ledger", async () => {
    const { fan, ticket } = await seed();
    const [first, second] = [await ticket(), await ticket()];
    const forgotten = await awaitingApproval(first, fan.id, longAgo());
    const forgottenTx = await recordRequest(first, forgotten.id, longAgo());
    const signed = await awaitingApproval(second, fan.id, longAgo());
    await recordRequest(second, signed.id, longAgo());
    const state: LedgerState = { request: txRequest("PENDING") };
    const { all, get } = deps(state);
    get.mockRejectedValue(new XrplServiceError("NOT_FOUND", "Transaction request not found"));

    await reconcileOfferCreation(all, forgotten.id);
    expect(await stateOf(forgotten.id)).toBe("FAILED");
    expect(await db.ledgerTransaction.findUniqueOrThrow({ where: { id: forgottenTx.id } })).toMatchObject({
      status: "DROPPED",
      appliedAt: expect.any(Date),
    });

    // A matching sell offer is on the ledger: it was signed, so it isn't freed for a second listing.
    state.sellOffers = [{ offerIndex: OFFER_INDEX, owner: HOLDER, amountDrops: PRICE }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconcileOfferCreation(all, signed.id);
    warn.mockRestore();
    expect(await stateOf(signed.id)).toBe("PENDING_SIGNATURE");
  });

  it("follows the transaction a forgotten request was signed into", async () => {
    const { fan, ticket } = await seed();
    const [listedT, rejectedT, lostT] = [await ticket(), await ticket(), await ticket()];
    const signedInto = async (t: { id: string; nftokenId: string | null }, hash: string) => {
      const row = await awaitingApproval(t, fan.id, longAgo());
      const tx = await recordRequest(t, row.id, longAgo(), hash); // seen as SUBMITTED earlier
      return { row, tx };
    };
    const ok = await signedInto(listedT, TX_HASH);
    const failed = await signedInto(rejectedT, TX_HASH.replace(/^E/, "F"));
    const never = await signedInto(lostT, TX_HASH.replace(/^E/, "A"));
    const state: LedgerState = {
      request: txRequest("PENDING"),
      sellOffers: [{ offerIndex: OFFER_INDEX, owner: HOLDER, amountDrops: PRICE }],
    };
    const { all, get, getValidatedTx } = deps(state);
    get.mockRejectedValue(new XrplServiceError("NOT_FOUND", "Transaction request not found"));

    // Validated with tesSUCCESS: recorded as created, from the ledger.
    await reconcileOfferCreation(all, ok.row.id);
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: ok.row.id } })).toMatchObject({
      state: "ACTIVE",
      offerIndex: OFFER_INDEX,
      createTxHash: TX_HASH,
    });

    // Validated with a tec result: FAILED, with the ledger's result.
    getValidatedTx.mockRejectedValueOnce(
      new XrplServiceError("TX_FAILED", "failed", { rippledError: "tecNO_PERMISSION" }),
    );
    await reconcileOfferCreation(all, failed.row.id);
    expect(await stateOf(failed.row.id)).toBe("FAILED");
    expect(await db.ledgerTransaction.findUniqueOrThrow({ where: { id: failed.tx.id } })).toMatchObject({
      status: "VALIDATED_FAILURE",
      resultCode: "tecNO_PERMISSION",
    });

    // Never validated, long after it could have been: released like an unsigned request.
    getValidatedTx.mockRejectedValueOnce(new XrplServiceError("NOT_VALIDATED", "not in a validated ledger"));
    state.sellOffers = [];
    await reconcileOfferCreation(all, never.row.id);
    expect(await stateOf(never.row.id)).toBe("FAILED");
    expect((await db.ledgerTransaction.findUniqueOrThrow({ where: { id: never.tx.id } })).status).toBe(
      "DROPPED",
    );
  });

  it("keeps one whose request can't be read for a moment", async () => {
    const { fan, ticket } = await seed();
    const sold = await ticket();
    const offer = await awaitingApproval(sold, fan.id, new Date());
    await recordRequest(sold, offer.id, new Date());
    const { all, get } = deps({ request: txRequest("PENDING") });
    get.mockRejectedValue(new XrplServiceError("NOT_FOUND", "Transaction request not found"));

    await reconcileOfferCreation(all, offer.id);
    expect(await stateOf(offer.id)).toBe("PENDING_SIGNATURE");
  });
});
