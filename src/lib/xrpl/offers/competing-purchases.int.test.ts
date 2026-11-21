import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmedLedgerTx, LedgerNftOffers, TransactionRequest } from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { nftokenIdFor } from "../tickets/__tests__/nft-ids";
import { listPrimaryOffers, UNSIGNABLE_AFTER_MS } from "./primary";
import { getOfferStatus, refreshOfferForSale, requestPurchase, type PurchaseDeps } from "./purchase";

/**
 * XRPL-035 against Postgres (`npm run test:db`): buyers competing for the same tickets. A ticket
 * someone else is buying isn't offered to the next buyer, a closed offer is never shown or sold,
 * and whoever loses is told why. Xaman and the ledger are controllable fakes.
 */

const db = getDb();
const SELLER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ALICE = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const BOB = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const PRICE = "2500000";
const provenance = {
  endpoint: "wss://node",
  ledgerIndex: 3000,
  ledgerHash: null,
  validated: true,
  fetchedAt: "",
};

const world = {
  /** Sell offers on the ledger, by offer index. */
  ledgerOffers: new Map<string, { nftokenId: string; owner: string; amountDrops: string }>(),
  /** Who holds each NFT on the ledger. */
  holders: new Map<string, string>(),
  /** Xaman requests, by ID. */
  requests: new Map<string, TransactionRequest>(),
  /** Validated purchases, by hash. */
  txs: new Map<string, ConfirmedLedgerTx>(),
  balanceDrops: "100000000",
  sequence: 0,
};

const create = vi.fn(async (input: { reference?: string | null; txjson: Record<string, unknown> }) => {
  const id = randomUUID();
  const request: TransactionRequest = {
    id,
    purpose: "ACCEPT_PRIMARY_OFFER",
    reference: input.reference ?? null,
    status: "PENDING",
    transactionType: "NFTokenAcceptOffer",
    account: input.txjson.Account as string,
    instruction: "Buy",
    signUrl: `https://xumm.app/sign/${id}`,
    qrPngUrl: `https://xumm.app/sign/${id}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
  };
  world.requests.set(id, request);
  return request;
});
const get = vi.fn(async (id: string) => world.requests.get(id) as TransactionRequest);

const ledger = {
  getValidatedTx: vi.fn(async (hash: string) => world.txs.get(hash) as ConfirmedLedgerTx),
  verifyOwner: vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.holders.get(nftokenId) === address,
    nft: null,
    provenance,
  })),
  getOffers: vi.fn(async (nftokenId: string): Promise<LedgerNftOffers> => ({
    nftokenId,
    sellOffers: [...world.ledgerOffers.entries()]
      .filter(([, offer]) => offer.nftokenId === nftokenId)
      .map(([offerIndex, offer]) => ({
        offerIndex,
        nftokenId,
        side: "SELL" as const,
        owner: offer.owner,
        amountDrops: offer.amountDrops,
        amountIssued: null,
        destination: null,
        expiresAt: null,
        flags: 1,
      })),
    buyOffers: [],
    provenance,
  })),
  getAccountInfo: vi.fn(async (address: string) => ({
    address,
    exists: true,
    balanceDrops: world.balanceDrops,
    sequence: 1,
    ownerCount: 0,
    provenance,
  })),
  getReserves: vi.fn(async () => ({ baseDrops: "1000000", incrementDrops: "200000" })),
};

const deps: PurchaseDeps = {
  db,
  transactions: () => ({ create, get }) as never,
  ledger: () => ledger as never,
  config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" },
};

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
  vi.clearAllMocks();
  world.ledgerOffers.clear();
  world.holders.clear();
  world.requests.clear();
  world.txs.clear();
  world.balanceDrops = "100000000";
});
afterAll(async () => {
  await db.$disconnect();
});

function sessionFor(userId: string, walletAddress: string): AuthSession {
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

/** A published event with `tickets` minted tickets, each listed for sale on the ledger. */
async function seed(tickets = 2) {
  const seller = await db.user.create({
    data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() },
  });
  const alice = await db.user.create({
    data: { displayName: "Alice", role: "CUSTOMER", onboardedAt: new Date() },
  });
  const bob = await db.user.create({
    data: { displayName: "Bob", role: "CUSTOMER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig",
      startsAt: new Date("2027-03-12T20:00:00Z"),
      venue: "Rooms",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: PRICE, totalSupply: tickets, mintedQuantity: tickets },
  });
  const offers = [];
  for (let serial = 1; serial <= tickets; serial += 1) {
    world.sequence += 1;
    const nftokenId = nftokenIdFor(SELLER, 7, world.sequence);
    const offerIndex = world.sequence.toString(16).toUpperCase().padStart(64, "A");
    const ticket = await db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial,
        issuerAddress: SELLER,
        mintStatus: "MINTED",
        nftokenId,
        mintTxHash: world.sequence.toString(16).toUpperCase().padStart(64, "B"),
        mintedAt: new Date(),
      },
    });
    const offer = await db.nFTOffer.create({
      data: {
        ticketId: ticket.id,
        nftokenId,
        kind: "PRIMARY",
        state: "ACTIVE",
        ownerAddress: SELLER,
        amountDrops: PRICE,
        offerIndex,
        createTxHash: world.sequence.toString(16).toUpperCase().padStart(64, "C"),
      },
    });
    world.ledgerOffers.set(offerIndex, { nftokenId, owner: SELLER, amountDrops: PRICE });
    world.holders.set(nftokenId, SELLER);
    offers.push(offer);
  }
  return {
    event,
    offers,
    alice: sessionFor(alice.id, ALICE),
    bob: sessionFor(bob.id, BOB),
    buy: (session: AuthSession, offerId: string) => requestPurchase(deps, { session, offerId }),
  };
}

const reasonOf = (reason: string) => ({ status: 409, details: { reason } });
const offerRow = (id: string) => db.nFTOffer.findUniqueOrThrow({ where: { id } });

/** `buyer`'s accept of the offer validates on the ledger: the NFT moves and the offer is consumed. */
function ledgerSale(offer: { nftokenId: string; offerIndex: string | null }, buyer: string) {
  world.sequence += 1;
  const hash = world.sequence.toString(16).toUpperCase().padStart(64, "D");
  world.ledgerOffers.delete(offer.offerIndex as string);
  world.holders.set(offer.nftokenId, buyer);
  world.txs.set(hash, {
    hash,
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 3001,
    closeTime: "2026-11-21T09:00:00.000Z",
    transactionType: "NFTokenAcceptOffer",
    account: buyer,
    nftokenId: offer.nftokenId,
    offerIndex: null,
    acceptedSellOfferIndex: offer.offerIndex,
    explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
  });
  return hash;
}

/** What Xaman says from now on about the request behind `requestId`. */
function answer(requestId: string, patch: Partial<TransactionRequest>) {
  world.requests.set(requestId, { ...(world.requests.get(requestId) as TransactionRequest), ...patch });
}

describe("what the next buyer is offered", () => {
  it("lists a ticket someone else is buying after the free ones, marked as held", async () => {
    const { event, offers, alice, buy } = await seed(3);
    await buy(alice, offers[0]!.id);

    const listed = await listPrimaryOffers(db, event.id, { viewerAddress: BOB });
    expect(listed.map((o) => [o.serial, o.purchasePending])).toEqual([
      [2, false],
      [3, false],
      [1, true],
    ]);
    // With no session the same ticket is held too: nobody else can buy it right now.
    expect((await listPrimaryOffers(db, event.id)).map((o) => o.serial)).toEqual([2, 3, 1]);
  });

  it("doesn't hide a buyer's own purchase in flight from them", async () => {
    const { event, offers, alice, buy } = await seed(2);
    await buy(alice, offers[0]!.id);

    const listed = await listPrimaryOffers(db, event.id, { viewerAddress: ALICE });
    expect(listed.map((o) => [o.serial, o.purchasePending])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it("stops counting a purchase nobody could still sign", async () => {
    const { event, offers, alice, buy } = await seed(1);
    await buy(alice, offers[0]!.id);
    expect((await listPrimaryOffers(db, event.id, { viewerAddress: BOB }))[0]!.purchasePending).toBe(true);

    await db.ledgerTransaction.updateMany({
      data: { createdAt: new Date(Date.now() - UNSIGNABLE_AFTER_MS - 1000) },
    });
    expect((await listPrimaryOffers(db, event.id, { viewerAddress: BOB }))[0]!.purchasePending).toBe(false);
  });

  it("never lists a closed offer, whatever closed it", async () => {
    const { event, offers } = await seed(6);
    const [accepted, cancelled, expired, stale, pastExpiry, open] = offers;
    await db.nFTOffer.update({ where: { id: accepted!.id }, data: { state: "ACCEPTED" } });
    await db.nFTOffer.update({ where: { id: cancelled!.id }, data: { state: "CANCELLED" } });
    await db.nFTOffer.update({ where: { id: expired!.id }, data: { state: "EXPIRED" } });
    await db.nFTOffer.update({ where: { id: stale!.id }, data: { state: "STALE" } });
    await db.nFTOffer.update({
      where: { id: pastExpiry!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await listPrimaryOffers(db, event.id)).map((o) => o.offerId)).toEqual([open!.id]);
  });
});

describe("two buyers, one ticket", () => {
  it("lets exactly one of two simultaneous buyers hold it, and tells the other someone is buying it", async () => {
    const { offers, alice, bob, buy } = await seed(1);

    const results = await Promise.allSettled([buy(alice, offers[0]!.id), buy(bob, offers[0]!.id)]);
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({
      ...reasonOf("PURCHASE_IN_FLIGHT"),
      message: "Someone is buying this ticket right now. Pick another one, or try again in a few minutes.",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("gives the second buyer the next ticket instead", async () => {
    const { event, offers, alice, bob, buy } = await seed(2);
    await buy(alice, offers[0]!.id);

    const next = (await listPrimaryOffers(db, event.id, { viewerAddress: BOB }))[0]!;
    expect(next).toMatchObject({ serial: 2, purchasePending: false });
    expect(await buy(bob, next.offerId)).toMatchObject({ serial: 2 });
  });

  it("frees the ticket for the second buyer once the first one's request expires", async () => {
    const { offers, alice, bob, buy } = await seed(1);
    const first = await buy(alice, offers[0]!.id);
    await expect(buy(bob, offers[0]!.id)).rejects.toMatchObject(reasonOf("PURCHASE_IN_FLIGHT"));

    answer(first.request.id, { status: "EXPIRED" });
    expect(await buy(bob, offers[0]!.id)).toMatchObject({ serial: 1 });
  });

  it("records the winner's validated purchase before answering the loser, who is told it's sold", async () => {
    const { offers, alice, bob, buy } = await seed(1);
    const first = await buy(alice, offers[0]!.id);
    // Alice approved and the ledger validated it, but she closed the page: nothing read it back.
    const hash = ledgerSale(offers[0]!, ALICE);
    answer(first.request.id, {
      status: "CONFIRMED",
      txHash: hash,
      engineResult: "tesSUCCESS",
      ledgerIndex: 3001,
    });

    await expect(buy(bob, offers[0]!.id)).rejects.toMatchObject({
      ...reasonOf("OFFER_CLOSED"),
      message: "This ticket is no longer for sale",
    });
    // The sale is on record as Alice's, not as an offer that vanished.
    expect(await offerRow(offers[0]!.id)).toMatchObject({
      state: "ACCEPTED",
      acceptTxHash: hash,
      acceptedByAddress: ALICE,
    });
    expect(await db.ticketNFT.findFirstOrThrow()).toMatchObject({
      primarySaleTxHash: hash,
      cachedOwnerAddress: ALICE,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("tells a buyer whose approval lost to a sale made outside the app, and closes the offer", async () => {
    const { offers, bob, buy } = await seed(1);
    const attempt = await buy(bob, offers[0]!.id);
    // Someone accepted the offer straight on the ledger while Bob was approving.
    ledgerSale(offers[0]!, ALICE);
    answer(attempt.request.id, {
      status: "FAILED",
      failureReason: "LEDGER_REJECTED",
      engineResult: "tecOBJECT_NOT_FOUND",
      txHash: "E".repeat(64),
      ledgerIndex: 3002,
    });

    const status = await getOfferStatus(deps, offers[0]!.id);
    expect(status).toMatchObject({ offer: { state: "STALE" }, soldAt: null, purchasePending: false });
    expect(await db.ledgerTransaction.findFirstOrThrow()).toMatchObject({
      status: "VALIDATED_FAILURE",
      resultCode: "tecOBJECT_NOT_FOUND",
      account: BOB,
    });
  });
});

describe("why a purchase is refused", () => {
  it.each([
    [
      "an offer that was cancelled",
      "OFFER_CLOSED",
      async (c: Awaited<ReturnType<typeof seed>>) => {
        await db.nFTOffer.update({ where: { id: c.offers[0]!.id }, data: { state: "CANCELLED" } });
      },
    ],
    [
      "an offer that expired",
      "OFFER_CLOSED",
      async (c: Awaited<ReturnType<typeof seed>>) => {
        await db.nFTOffer.update({ where: { id: c.offers[0]!.id }, data: { state: "EXPIRED" } });
      },
    ],
    [
      "a ticket that is already sold",
      "OFFER_CLOSED",
      async (c: Awaited<ReturnType<typeof seed>>) => {
        await db.ticketNFT.updateMany({ data: { primarySoldAt: new Date() } });
        expect(c.offers).toHaveLength(1);
      },
    ],
    [
      "an offer the ledger no longer has",
      "OFFER_GONE",
      async () => {
        world.ledgerOffers.clear();
      },
    ],
    [
      "a ticket the seller no longer holds",
      "OFFER_GONE",
      async (c: Awaited<ReturnType<typeof seed>>) => {
        world.holders.set(c.offers[0]!.nftokenId, ALICE);
      },
    ],
    [
      "a ticket already used at the door",
      "TICKET_USED",
      async (c: Awaited<ReturnType<typeof seed>>) => {
        await db.checkInRecord.create({
          data: {
            ticketId: c.offers[0]!.ticketId as string,
            eventId: c.event.id,
            organiserId: c.event.sellerId,
            walletAddress: SELLER,
          },
        });
      },
    ],
    [
      "a wallet that can't pay",
      "WALLET_NOT_READY",
      async () => {
        world.balanceDrops = "1000000";
      },
    ],
  ] as const)("names the reason for %s", async (_label, reason, arrange) => {
    const context = await seed(1);
    await arrange(context);

    await expect(context.buy(context.bob, context.offers[0]!.id)).rejects.toMatchObject(reasonOf(reason));
    expect(create).not.toHaveBeenCalled();
  });

  it("names the reason for the buyer's own wallet and their own purchase in flight", async () => {
    const { offers, alice, bob, buy } = await seed(1);
    await expect(buy(sessionFor(bob.userId, SELLER), offers[0]!.id)).rejects.toMatchObject(
      reasonOf("OWN_OFFER"),
    );

    await buy(alice, offers[0]!.id);
    await expect(buy(alice, offers[0]!.id)).rejects.toMatchObject(reasonOf("OWN_PURCHASE_IN_FLIGHT"));
  });
});

describe("checking an offer before it's shown for sale", () => {
  it("closes an offer taken outside the app, so it leaves the listing", async () => {
    const { event, offers } = await seed(2);
    ledgerSale(offers[0]!, ALICE);

    expect(await refreshOfferForSale(deps, offers[0]!.id)).toBe("STALE");
    expect((await listPrimaryOffers(db, event.id)).map((o) => o.serial)).toEqual([2]);
  });

  it("closes an offer the seller withdrew on the ledger", async () => {
    const { offers } = await seed(1);
    world.ledgerOffers.clear(); // cancelled outside the app: the seller still holds the ticket

    expect(await refreshOfferForSale(deps, offers[0]!.id)).toBe("STALE");
  });

  it("marks an offer past its expiry EXPIRED", async () => {
    const { offers } = await seed(1);
    await db.nFTOffer.update({
      where: { id: offers[0]!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await refreshOfferForSale(deps, offers[0]!.id)).toBe("EXPIRED");
  });

  it("records a validated purchase nobody read back", async () => {
    const { event, offers, alice, buy } = await seed(1);
    const first = await buy(alice, offers[0]!.id);
    const hash = ledgerSale(offers[0]!, ALICE);
    answer(first.request.id, {
      status: "CONFIRMED",
      txHash: hash,
      engineResult: "tesSUCCESS",
      ledgerIndex: 3001,
    });

    expect(await refreshOfferForSale(deps, offers[0]!.id)).toBe("ACCEPTED");
    expect(await listPrimaryOffers(db, event.id)).toEqual([]);
  });

  it("leaves an offer that is live, and one with a purchase still in flight", async () => {
    const { offers, alice, buy } = await seed(2);
    expect(await refreshOfferForSale(deps, offers[0]!.id)).toBe("ACTIVE");

    await buy(alice, offers[1]!.id);
    world.ledgerOffers.clear(); // even if the ledger looks different: the purchase records its own outcome
    expect(await refreshOfferForSale(deps, offers[1]!.id)).toBe("ACTIVE");
  });

  it("answers null for an offer that doesn't exist", async () => {
    expect(await refreshOfferForSale(deps, randomUUID())).toBeNull();
  });
});
