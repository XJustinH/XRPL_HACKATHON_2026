import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as availabilityGET } from "@/app/api/events/[id]/availability/route";
import { createSession, sessionCookieName } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { ResalePolicy } from "@/lib/resale-policy/resale-policy";
import { createInventoryPort, getPrimaryAvailability, getPrimaryAvailabilityMany } from "./primary-inventory";

/**
 * XRPL-020 against Postgres: primary remaining / sell-out state, and the resale trigger it drives
 * through Agent D's real ResalePolicy (XRPL-037).
 */

const db = getDb();
const SELLER_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
let seq = 0;
const hex64 = () => (++seq).toString(16).toUpperCase().padStart(64, "0");

async function seller() {
  return db.user.create({ data: { displayName: "Venue", role: "SELLER", onboardedAt: new Date() } });
}

async function event(sellerId: string, status: "DRAFT" | "PUBLISHED" = "PUBLISHED") {
  return db.event.create({
    data: {
      sellerId,
      status,
      title: "Gig",
      startsAt: new Date(Date.now() + 30 * 24 * 3600_000),
      venue: "Vicar St",
      city: "Dublin",
      publishedAt: status === "PUBLISHED" ? new Date() : null,
    },
  });
}

const tier = (eventId: string, name: string, totalSupply: number, priceDrops = "25000000") =>
  db.ticketTier.create({ data: { eventId, name, totalSupply, priceDrops } });

async function minted(eventId: string, tierId: string, serial: number) {
  await db.ticketTier.update({ where: { id: tierId }, data: { mintedQuantity: { increment: 1 } } });
  return db.ticketNFT.create({
    data: { eventId, tierId, serial, nftokenId: hex64(), mintStatus: "MINTED", mintTxHash: hex64(), mintedAt: new Date() },
  });
}

const primaryOffer = (ticket: { id: string; nftokenId: string | null }, state: "ACTIVE" | "EXPIRED" | "CANCELLED", amountDrops: string) =>
  db.nFTOffer.create({
    data: { ticketId: ticket.id, nftokenId: ticket.nftokenId!, kind: "PRIMARY", state, ownerAddress: SELLER_WALLET, amountDrops },
  });

const sell = (ticketId: string) =>
  db.ticketNFT.update({ where: { id: ticketId }, data: { primarySoldAt: new Date(), primarySaleTxHash: hex64() } });

const pendingPurchase = (ticketId: string) =>
  db.ledgerTransaction.create({ data: { type: "NFTokenAcceptOffer", status: "PENDING", relatedTicketId: ticketId } });

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("primary availability", () => {
  it("counts only validated sales; unminted supply, pending purchases and dead offers stay remaining", async () => {
    const s = await seller();
    const e = await event(s.id);
    const ga = await tier(e.id, "GA", 3);
    const t1 = await minted(e.id, ga.id, 1);
    const t2 = await minted(e.id, ga.id, 2);
    // serial 3 is not minted yet

    await sell(t1.id);
    await primaryOffer(t2, "EXPIRED", "10000000"); // dead offers never count
    await primaryOffer(t2, "CANCELLED", "11000000");
    await primaryOffer(t2, "ACTIVE", "30000000");
    await pendingPurchase(t2.id);

    const a = await getPrimaryAvailability(db, e.id);
    expect(a).toMatchObject({ totalSupply: 3, sold: 1, remaining: 2, pending: 1, isSoldOut: false, fromPriceDrops: "30000000" });
    expect(a.tiers).toEqual([
      expect.objectContaining({ name: "GA", totalSupply: 3, sold: 1, remaining: 2, pending: 1, fromPriceDrops: "30000000" }),
    ]);
  });

  it("does not count failed mints as sold or as stock gone", async () => {
    const s = await seller();
    const e = await event(s.id);
    const ga = await tier(e.id, "GA", 2);
    await sell((await minted(e.id, ga.id, 1)).id);
    await db.ticketNFT.create({ data: { eventId: e.id, tierId: ga.id, serial: 2, mintStatus: "FAILED" } });

    expect(await getPrimaryAvailability(db, e.id)).toMatchObject({ sold: 1, remaining: 1, isSoldOut: false });
  });

  it("answers several events at once, and empty events as not sold out", async () => {
    const s = await seller();
    const a = await event(s.id);
    const b = await event(s.id);
    const tierA = await tier(a.id, "GA", 1);
    await sell((await minted(a.id, tierA.id, 1)).id);
    const unknown = "99999999-9999-4999-8999-999999999999";

    const many = await getPrimaryAvailabilityMany(db, [a.id, b.id, unknown, a.id]);
    expect(many.get(a.id)).toMatchObject({ totalSupply: 1, sold: 1, isSoldOut: true });
    expect(many.get(b.id)).toMatchObject({ totalSupply: 0, isSoldOut: false, tiers: [] });
    expect(many.get(unknown)).toMatchObject({ totalSupply: 0, isSoldOut: false });
  });
});

describe("resale opens only after all primary inventory is sold (with Agent D's ResalePolicy)", () => {
  it("stays closed through every partial state and opens on the last validated sale", async () => {
    const s = await seller();
    const e = await event(s.id);
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
    const reason = async () => (await policy.getEligibility(e.id)).reasonCode;

    const ga = await tier(e.id, "GA", 2);
    const vip = await tier(e.id, "VIP", 1, "75000000");
    expect(await reason()).toBe("PRIMARY_STILL_ON_SALE"); // nothing minted

    const g1 = await minted(e.id, ga.id, 1);
    const g2 = await minted(e.id, ga.id, 2);
    const v1 = await minted(e.id, vip.id, 1);
    for (const t of [g1, g2, v1]) await primaryOffer(t, "ACTIVE", t.tierId === vip.id ? "75000000" : "25000000");
    expect(await reason()).toBe("PRIMARY_STILL_ON_SALE"); // all minted and listed, none sold

    await sell(g1.id);
    await sell(g2.id);
    expect(await reason()).toBe("PRIMARY_STILL_ON_SALE"); // one tier sold out, the other isn't

    await db.nFTOffer.updateMany({ where: { ticketId: v1.id }, data: { state: "EXPIRED" } });
    expect(await reason()).toBe("PRIMARY_STILL_ON_SALE"); // expired offer: ticket is still unsold

    await pendingPurchase(v1.id);
    expect(await reason()).toBe("PRIMARY_STILL_ON_SALE"); // last ticket only pending, not validated

    await sell(v1.id);
    const open = await policy.getEligibility(e.id);
    expect(open).toMatchObject({ reasonCode: "PRIMARY_SOLD_OUT", isPublicResaleAllowed: true });
  });

  it("stays closed when every minted ticket sold but supply is not fully minted", async () => {
    const s = await seller();
    const e = await event(s.id);
    const ga = await tier(e.id, "GA", 2);
    await sell((await minted(e.id, ga.id, 1)).id);
    const inventory = createInventoryPort(db);
    expect((await inventory.getAvailability(e.id)).isSoldOut).toBe(false);
  });
});

describe("GET /api/events/:id/availability", () => {
  const ORIGIN = "http://localhost:3000";
  const get = (id: string, cookie?: string) =>
    availabilityGET(new Request(`${ORIGIN}/api/events/${id}/availability`, { headers: cookie ? { cookie } : {} }), {
      params: Promise.resolve({ id }),
    });
  const cookieFor = async (userId: string) => `${sessionCookieName()}=${(await createSession(db, userId, "ONBOARDING")).token}`;

  it("is public for published events and not cached", async () => {
    const s = await seller();
    const e = await event(s.id);
    await tier(e.id, "GA", 2);
    const res = await get(e.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ eventId: e.id, totalSupply: 2, remaining: 2, isSoldOut: false });
  });

  it("hides drafts from everyone but their owner", async () => {
    const owner = await seller();
    const other = await seller();
    const draft = await event(owner.id, "DRAFT");
    expect((await get(draft.id)).status).toBe(404);
    expect((await get(draft.id, await cookieFor(other.id))).status).toBe(404);
    expect((await get(draft.id, await cookieFor(owner.id))).status).toBe(200);
  });

  it("404s unknown or malformed ids", async () => {
    expect((await get("99999999-9999-4999-8999-999999999999")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});
