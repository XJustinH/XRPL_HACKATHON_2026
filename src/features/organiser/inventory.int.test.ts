import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { getEventInventory } from "./inventory";

/** XRPL-021 inventory counts against Postgres (`npm run test:db`). */

const db = getDb();
const hex = (prefix: string, n: number) => (prefix + n.toString(16)).toUpperCase().padStart(64, "0");
const OWNER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
let serial = 0;

beforeEach(async () => {
  serial = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seedEvent() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "Dublin", status: "PUBLISHED" },
  });
  const ga = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 3, sortOrder: 0 } });
  const vip = await db.ticketTier.create({ data: { eventId: event.id, name: "VIP", priceDrops: "10000000", totalSupply: 2, sortOrder: 1 } });
  return { seller, event, ga, vip };
}

async function ticket(eventId: string, tierId: string, state: "PENDING" | "MINTED" | "SOLD") {
  serial += 1;
  const minted = state !== "PENDING";
  return db.ticketNFT.create({
    data: {
      eventId,
      tierId,
      serial,
      mintStatus: minted ? "MINTED" : "PENDING",
      nftokenId: minted ? hex("A", serial) : null,
      mintTxHash: minted ? hex("B", serial) : null,
      mintedAt: minted ? new Date() : null,
      primarySoldAt: state === "SOLD" ? new Date() : null,
      primarySaleTxHash: state === "SOLD" ? hex("C", serial) : null,
    },
  });
}

async function primaryOffer(t: { id: string; nftokenId: string | null }, state: "ACTIVE" | "CANCELLED") {
  await db.nFTOffer.create({
    data: {
      ticketId: t.id,
      nftokenId: t.nftokenId!,
      offerIndex: hex("D", serial * 10 + (state === "ACTIVE" ? 1 : 2)),
      kind: "PRIMARY",
      state,
      ownerAddress: OWNER,
      amountDrops: "2500000",
    },
  });
}

describe("getEventInventory", () => {
  it("counts minted, minting, on sale, sold and unsold per tier", async () => {
    const { event, ga, vip } = await seedEvent();
    const sold = await ticket(event.id, ga.id, "SOLD");
    await primaryOffer(sold, "ACTIVE"); // stale mirror on a sold ticket must not count as on sale
    const listed = await ticket(event.id, ga.id, "MINTED");
    await primaryOffer(listed, "ACTIVE");
    const unlisted = await ticket(event.id, ga.id, "MINTED");
    await primaryOffer(unlisted, "CANCELLED");
    await ticket(event.id, vip.id, "PENDING");

    const inv = await getEventInventory(db, event.id);
    expect(inv.tiers.map((t) => t.name)).toEqual(["GA", "VIP"]);
    expect(inv.tiers[0]).toMatchObject({ total: 3, minted: 3, minting: 0, onSale: 1, sold: 1, unsold: 2 });
    expect(inv.tiers[1]).toMatchObject({ total: 2, minted: 0, minting: 1, onSale: 0, sold: 0, unsold: 2 });
    expect(inv.totals).toEqual({ total: 5, minted: 3, minting: 1, onSale: 1, sold: 1, unsold: 4 });
    expect(inv.primarySoldOut).toBe(false);
  });

  it("updates once a purchase is confirmed, and reports sold out when every ticket is sold", async () => {
    const { event, ga, vip } = await seedEvent();
    for (let i = 0; i < 3; i += 1) await ticket(event.id, ga.id, "SOLD");
    await ticket(event.id, vip.id, "SOLD");
    const last = await ticket(event.id, vip.id, "MINTED");
    expect((await getEventInventory(db, event.id)).primarySoldOut).toBe(false);

    // A validated primary sale is what sets primarySoldAt (XRPL-032).
    await db.ticketNFT.update({ where: { id: last.id }, data: { primarySoldAt: new Date(), primarySaleTxHash: hex("E", 1) } });
    const inv = await getEventInventory(db, event.id);
    expect(inv.totals).toMatchObject({ sold: 5, unsold: 0 });
    expect(inv.primarySoldOut).toBe(true);
  });

  it("only counts this event, and includes check-ins", async () => {
    const a = await seedEvent();
    const b = await seedEvent();
    const t = await ticket(a.event.id, a.ga.id, "SOLD");
    await ticket(b.event.id, b.ga.id, "SOLD");
    await db.checkInRecord.create({
      data: { ticketId: t.id, eventId: a.event.id, organiserId: a.seller.id, walletAddress: OWNER },
    });
    const inv = await getEventInventory(db, a.event.id);
    expect(inv.totals.sold).toBe(1);
    expect(inv.checkedIn).toBe(1);
  });

  it("returns empty tiers for an event without any", async () => {
    const seller = await db.user.create({ data: { displayName: "S", role: "SELLER" } });
    const event = await db.event.create({
      data: { sellerId: seller.id, title: "Empty", startsAt: new Date(), venue: "V", city: "C" },
    });
    const inv = await getEventInventory(db, event.id);
    expect(inv.tiers).toEqual([]);
    expect(inv.primarySoldOut).toBe(false);
  });
});
