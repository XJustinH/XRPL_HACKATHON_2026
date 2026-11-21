import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { createInventoryPort } from "@/lib/inventory/primary-inventory";
import { PrismaResaleOffers, prismaPolicyEvents } from "./prisma-adapters";
import { ResalePolicy } from "./resale-policy";

/**
 * XRPL-037 end to end on Postgres: the real policy with Agent A's inventory port (XRPL-020) and the
 * offer mirror (`npm run test:db`).
 */

const db = getDb();
const hex = (prefix: string, n: number) => (prefix + n.toString(16)).toUpperCase().padStart(64, "0");
const SELLER_ADDR = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const FRIEND = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
let n = 0;

const policy = () =>
  new ResalePolicy({ events: prismaPolicyEvents(db), inventory: createInventoryPort(db), offers: new PrismaResaleOffers(db) });

beforeEach(async () => {
  n = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed({ supply = 2, status = "PUBLISHED" as "PUBLISHED" | "DRAFT", startsAt = "2099-12-01T20:00:00Z" } = {}) {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date(startsAt), venue: "Vicar St", city: "Dublin", status },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: supply } });
  return { event, tier };
}

async function ticket(eventId: string, tierId: string, sold: boolean) {
  n += 1;
  return db.ticketNFT.create({
    data: {
      eventId,
      tierId,
      serial: n,
      mintStatus: "MINTED",
      nftokenId: hex("A", n),
      mintTxHash: hex("B", n),
      mintedAt: new Date(),
      primarySoldAt: sold ? new Date() : null,
      primarySaleTxHash: sold ? hex("C", n) : null,
    },
  });
}

type OfferOpts = { kind?: "RESALE" | "PRIVATE"; state?: "ACTIVE" | "CANCELLED"; validated?: boolean; amountDrops: string };
async function offer(t: { id: string; nftokenId: string | null }, o: OfferOpts) {
  n += 1;
  const kind = o.kind ?? "RESALE";
  return db.nFTOffer.create({
    data: {
      ticketId: t.id,
      nftokenId: t.nftokenId!,
      kind,
      state: o.state ?? "ACTIVE",
      ownerAddress: SELLER_ADDR,
      destinationAddress: kind === "PRIVATE" ? FRIEND : null,
      amountDrops: o.amountDrops,
      offerIndex: o.validated === false ? null : hex("D", n),
      createTxHash: o.validated === false ? null : hex("E", n),
    },
  });
}

describe("ResalePolicy on Postgres", () => {
  it("lists only live, validated, public resale offers once sold out, cheapest first", async () => {
    const { event, tier } = await seed();
    const t1 = await ticket(event.id, tier.id, true);
    const t2 = await ticket(event.id, tier.id, true);
    const pricey = await offer(t1, { amountDrops: "4000000" });
    const cheap = await offer(t2, { amountDrops: "3000000" });
    await offer(t1, { kind: "PRIVATE", amountDrops: "1000000" });
    await offer(t2, { state: "CANCELLED", amountDrops: "1000000" });
    await offer(t2, { validated: false, amountDrops: "1000000" });
    const other = await seed();
    const ot = await ticket(other.event.id, other.tier.id, true);
    await offer(ot, { amountDrops: "1000000" });

    const { eligibility, offers } = await policy().listPublicOffers(event.id);
    expect(eligibility).toMatchObject({ isPublicResaleAllowed: true, reasonCode: "PRIMARY_SOLD_OUT" });
    expect(offers.map((o) => o.offerId)).toEqual([cheap.id, pricey.id]);
    expect(offers[0]).toMatchObject({
      sellerAddress: SELLER_ADDR,
      amountDrops: "3000000",
      ticket: { id: t2.id, tierName: "GA", faceValueDrops: "2500000" },
      event: { id: event.id, title: "Gig", venue: "Vicar St", city: "Dublin" },
    });
  });

  it("drops the listing of a ticket already used to enter the event", async () => {
    const { event, tier } = await seed({ supply: 2 });
    const used = await ticket(event.id, tier.id, true);
    const fresh = await ticket(event.id, tier.id, true);
    const usedOffer = await offer(used, { amountDrops: "3000000" });
    const freshOffer = await offer(fresh, { amountDrops: "3000000" });
    await db.checkInRecord.create({
      data: { ticketId: used.id, eventId: event.id, organiserId: event.sellerId, walletAddress: SELLER_ADDR },
    });

    const p = policy();
    expect((await p.listPublicOffers(event.id)).offers.map((o) => o.offerId)).toEqual([freshOffer.id]);
    expect(await p.getPublicOffer(event.id, usedOffer.id)).toBeNull();
  });

  it("hides every listing while a primary ticket is unsold, including direct lookup", async () => {
    const { event, tier } = await seed();
    const sold = await ticket(event.id, tier.id, true);
    await ticket(event.id, tier.id, false);
    const o = await offer(sold, { amountDrops: "3000000" });
    const p = policy();
    expect((await p.getEligibility(event.id)).reasonCode).toBe("PRIMARY_STILL_ON_SALE");
    expect((await p.listPublicOffers(event.id)).offers).toEqual([]);
    expect(await p.getPublicOffer(event.id, o.id)).toBeNull();
  });

  it("a purchase still pending on XRPL does not open resale", async () => {
    const { event, tier } = await seed({ supply: 1 });
    const t = await ticket(event.id, tier.id, false);
    await db.ledgerTransaction.create({ data: { type: "NFTokenAcceptOffer", status: "PENDING", relatedTicketId: t.id } });
    expect((await policy().getEligibility(event.id)).isPublicResaleAllowed).toBe(false);
  });

  it("is closed for drafts and finished events", async () => {
    const draft = await seed({ status: "DRAFT", supply: 1 });
    await ticket(draft.event.id, draft.tier.id, true);
    expect((await policy().getEligibility(draft.event.id)).reasonCode).toBe("EVENT_NOT_PUBLISHED");

    const past = await seed({ startsAt: "2020-01-01T20:00:00Z", supply: 1 });
    await ticket(past.event.id, past.tier.id, true);
    expect((await policy().getEligibility(past.event.id)).reasonCode).toBe("EVENT_FINISHED");
  });
});
