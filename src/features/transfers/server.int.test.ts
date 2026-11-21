import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import { getDb } from "@/lib/db/client";
import { setResalePolicyForTests } from "@/lib/resale-policy/server";

import { getOfferPage, getOpenOffer, listResaleListings } from "./server";

/**
 * What the transfer screens may show (XRPL-034, 038, 039, 040, 041), against Postgres
 * (`npm run test:db`) with the real in-app resale rule.
 */

const db = getDb();
const HOLDER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const STRANGER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const hex = (prefix: string, n: number) => (prefix + n.toString(16)).toUpperCase().padStart(64, "0");
let n = 0;

beforeEach(async () => {
  n = 0;
  setResalePolicyForTests(null);
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  setResalePolicyForTests(null);
  await db.$disconnect();
});

/** A published, upcoming event with `sold` of its `supply` tickets sold on primary. */
async function seed(title: string, { supply = 1, sold = 1 } = {}) {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title, startsAt: new Date("2099-06-01T20:00:00Z"), venue: "Vicar St", city: "Dublin", status: "PUBLISHED" },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: supply } });
  const tickets = [];
  for (let i = 0; i < supply; i += 1) {
    n += 1;
    tickets.push(
      await db.ticketNFT.create({
        data: {
          eventId: event.id,
          tierId: tier.id,
          serial: i + 1,
          mintStatus: "MINTED",
          nftokenId: hex("A", n),
          mintTxHash: hex("B", n),
          mintedAt: new Date(),
          primarySoldAt: i < sold ? new Date() : null,
          primarySaleTxHash: i < sold ? hex("C", n) : null,
        },
      }),
    );
  }
  return { seller, event, tickets };
}

const provenance = { endpoint: "wss://node", ledgerIndex: 3000, ledgerHash: null, validated: true, fetchedAt: "" };

/**
 * The ticket services' deps with a ledger that agrees with the app: every ACTIVE offer is live, and
 * `world.holder` holds every NFT. `world.down` makes the ledger unreachable.
 */
function deps(world: { holder?: string; down?: boolean } = {}) {
  const getOffers = async (nftokenId: string) => {
    if (world.down) throw new Error("ledger unreachable");
    const active = await db.nFTOffer.findMany({ where: { nftokenId, state: "ACTIVE" } });
    return {
      nftokenId,
      buyOffers: [],
      provenance,
      sellOffers: active.map((o) => ({
        offerIndex: o.offerIndex,
        nftokenId,
        side: "SELL",
        owner: o.ownerAddress,
        amountDrops: o.amountDrops,
        amountIssued: null,
        destination: o.destinationAddress,
        expiresAt: null,
        flags: 1,
      })),
    };
  };
  const verifyOwner = async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: address === (world.holder ?? HOLDER),
    nft: null,
    provenance,
  });
  return {
    db,
    transactions: () => ({ create: vi.fn(), get: vi.fn() }) as never,
    ledger: () => ({ getValidatedTx: vi.fn(), getOffers, verifyOwner }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org" } as never,
  };
}

async function offer(
  ticket: { id: string; nftokenId: string | null },
  kind: "PRIMARY" | "RESALE" | "PRIVATE" | "GIFT",
  state: "PENDING_SIGNATURE" | "ACTIVE" | "ACCEPTED" = "ACTIVE",
) {
  n += 1;
  const live = state !== "PENDING_SIGNATURE";
  return db.nFTOffer.create({
    data: {
      ticketId: ticket.id,
      nftokenId: ticket.nftokenId!,
      kind,
      state,
      ownerAddress: HOLDER,
      destinationAddress: kind === "PRIVATE" || kind === "GIFT" ? FRIEND : null,
      amountDrops: kind === "GIFT" ? "0" : "3000000",
      offerIndex: live ? hex("D", n) : null,
      createTxHash: live ? hex("E", n) : null,
    },
  });
}

describe("getOfferPage", () => {
  it("shows a gift only to the wallet it names", async () => {
    const { tickets } = await seed("Gig");
    const gift = await offer(tickets[0]!, "GIFT");

    expect(await getOfferPage(deps(), gift.id, null)).toEqual({ status: "NOT_FOR_YOU" });
    expect(await getOfferPage(deps(), gift.id, STRANGER)).toEqual({ status: "NOT_FOR_YOU" });
    expect(await getOfferPage(deps(), gift.id, FRIEND)).toMatchObject({
      status: "OPEN",
      offer: { kind: "GIFT", amountDrops: "0", sellerAddress: HOLDER, used: false, ticket: { tierName: "GA" }, event: { title: "Gig" } },
    });
  });

  it("closes an offer once its ticket has been used to enter the event", async () => {
    const { seller, event, tickets } = await seed("Gig");
    const sale = await offer(tickets[0]!, "PRIVATE");
    await db.checkInRecord.create({
      data: { ticketId: tickets[0]!.id, eventId: event.id, organiserId: seller.id, walletAddress: HOLDER },
    });

    expect(await getOfferPage(deps(), sale.id, FRIEND)).toMatchObject({ status: "CLOSED", offer: { used: true } });
  });

  it("shows a resale offer to anyone only while the resale rule lists it", async () => {
    const soldOut = await seed("Sold out");
    const listed = await offer(soldOut.tickets[0]!, "RESALE");
    expect(await getOfferPage(deps(), listed.id, null)).toMatchObject({ status: "OPEN", offer: { kind: "RESALE" } });

    // Primary tickets still on sale: resale isn't open in the app, so the offer isn't shown at all.
    const onSale = await seed("On sale", { supply: 2, sold: 1 });
    const early = await offer(onSale.tickets[0]!, "RESALE");
    expect(await getOfferPage(deps(), early.id, STRANGER)).toEqual({ status: "NOT_FOUND" });
  });

  it("closes an offer the ledger no longer backs, and shows it as recorded while the ledger is down", async () => {
    const { tickets } = await seed("Gig");
    const gift = await offer(tickets[0]!, "GIFT");

    expect(await getOfferPage(deps({ down: true }), gift.id, FRIEND)).toMatchObject({ status: "OPEN" });
    expect(await getOfferPage(deps({ holder: STRANGER }), gift.id, FRIEND)).toMatchObject({
      status: "CLOSED",
      offer: { state: "STALE" },
    });
  });

  it("never shows primary offers or unknown ids here, and closes accepted offers", async () => {
    const { tickets } = await seed("Gig", { supply: 2, sold: 1 });
    const primary = await offer(tickets[1]!, "PRIMARY");
    const accepted = await offer(tickets[0]!, "GIFT", "ACCEPTED");

    expect(await getOfferPage(deps(), primary.id, null)).toEqual({ status: "NOT_FOUND" });
    expect(await getOfferPage(deps(), "00000000-0000-4000-8000-000000000000", null)).toEqual({ status: "NOT_FOUND" });
    expect(await getOfferPage(deps(), accepted.id, FRIEND)).toMatchObject({ status: "CLOSED", offer: { state: "ACCEPTED" } });
  });
});

describe("getOpenOffer", () => {
  it("returns the holder's live offer, awaiting approval or active", async () => {
    const { tickets } = await seed("Gig");
    expect(await getOpenOffer(deps(), tickets[0]!.id, HOLDER)).toBeNull();

    const pending = await offer(tickets[0]!, "GIFT", "PENDING_SIGNATURE");
    expect(await getOpenOffer(deps(), tickets[0]!.id, HOLDER)).toEqual({
      id: pending.id,
      kind: "GIFT",
      state: "PENDING_SIGNATURE",
      amountDrops: "0",
      destinationAddress: FRIEND,
      cancelPending: false,
    });
    expect(await getOpenOffer(deps(), tickets[0]!.id, STRANGER)).toBeNull();
  });

  it("drops an offer the ledger no longer backs, and says when a cancellation is waiting", async () => {
    const { tickets } = await seed("Gig");
    const listed = await offer(tickets[0]!, "RESALE");

    await db.ledgerTransaction.create({
      data: { type: "NFTokenCancelOffer", status: "PENDING", account: HOLDER, relatedOfferId: listed.id },
    });
    expect(await getOpenOffer(deps(), tickets[0]!.id, HOLDER)).toMatchObject({ id: listed.id, cancelPending: true });
    await db.ledgerTransaction.deleteMany();

    // Sold elsewhere: the holder's wallet no longer has the NFT, so the offer can't complete.
    expect(await getOpenOffer(deps({ holder: STRANGER }), tickets[0]!.id, HOLDER)).toBeNull();
    expect((await db.nFTOffer.findUniqueOrThrow({ where: { id: listed.id } })).state).toBe("STALE");
  });
});

describe("listResaleListings", () => {
  it("lists every upcoming event's resale tickets, or one event's with why it may have none", async () => {
    const a = await seed("Alpha");
    const b = await seed("Beta");
    const onSale = await seed("Gamma", { supply: 2, sold: 1 });
    const offerA = await offer(a.tickets[0]!, "RESALE");
    const offerB = await offer(b.tickets[0]!, "RESALE");
    await offer(onSale.tickets[0]!, "RESALE");

    const all = await listResaleListings(db);
    expect(all.event).toBeNull();
    expect(all.listings.map((l) => l.offerId).sort()).toEqual([offerA.id, offerB.id].sort());

    const one = await listResaleListings(db, { eventId: a.event.id });
    expect(one.listings.map((l) => l.offerId)).toEqual([offerA.id]);
    expect(one.event).toMatchObject({ id: a.event.id, title: "Alpha" });

    const closed = await listResaleListings(db, { eventId: onSale.event.id });
    expect(closed.listings).toEqual([]);
    expect(closed.event?.message).toMatch(/once all primary tickets have sold/);
    // The pages print the limitation notice once themselves.
    expect(closed.event?.message).not.toContain(RESALE_LIMITATION_NOTICE);

    // An unknown event falls back to every listing.
    const unknown = await listResaleListings(db, { eventId: "00000000-0000-4000-8000-000000000000" });
    expect(unknown.event).toBeNull();
    expect(unknown.listings).toHaveLength(2);
  });
});
