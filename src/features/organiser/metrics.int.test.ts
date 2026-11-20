import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { getEventMetrics } from "./metrics";

/** XRPL-076 metrics against Postgres (`npm run test:db`). */

const db = getDb();
const hex = (prefix: string, n: number) => (prefix + n.toString(16)).toUpperCase().padStart(64, "0");
const A = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const B = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
let n = 0;

beforeEach(async () => {
  n = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "Dublin", status: "PUBLISHED" },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 4 } });
  return { seller, event, tier };
}

async function soldTicket(eventId: string, tierId: string) {
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
      primarySoldAt: new Date(),
      primarySaleTxHash: hex("C", n),
    },
  });
}

async function offer(
  t: { id: string; nftokenId: string | null },
  kind: "PRIMARY" | "RESALE" | "PRIVATE" | "GIFT",
  state: "ACCEPTED" | "ACTIVE" | "CANCELLED",
  amountDrops: string,
) {
  n += 1;
  await db.nFTOffer.create({
    data: {
      ticketId: t.id,
      nftokenId: t.nftokenId!,
      offerIndex: hex("D", n),
      kind,
      state,
      ownerAddress: A,
      destinationAddress: kind === "PRIVATE" || kind === "GIFT" ? B : null,
      amountDrops,
    },
  });
}

describe("getEventMetrics", () => {
  it("counts only validated sales, accepted offers and recorded check-ins", async () => {
    const { seller, event, tier } = await seed();
    const t1 = await soldTicket(event.id, tier.id);
    const t2 = await soldTicket(event.id, tier.id);
    await offer(t1, "PRIMARY", "ACCEPTED", "2500000");
    await offer(t2, "PRIMARY", "ACCEPTED", "2500000");
    await offer(t1, "RESALE", "ACCEPTED", "4000000");
    await offer(t2, "RESALE", "ACTIVE", "9000000"); // listed, not sold: excluded
    await offer(t2, "RESALE", "CANCELLED", "8000000"); // excluded
    await offer(t2, "PRIVATE", "ACCEPTED", "1000000");
    await offer(t1, "GIFT", "ACCEPTED", "0");
    await db.checkInRecord.create({
      data: { ticketId: t1.id, eventId: event.id, organiserId: seller.id, walletAddress: A, scannedAt: new Date("2026-12-01T20:02:00Z") },
    });

    const m = await getEventMetrics(db, event.id);
    expect(m).toMatchObject({
      ticketsTotal: 4,
      primarySold: 2,
      primaryRevenueDrops: "5000000",
      resales: 1,
      resaleVolumeDrops: "4000000",
      privateTransfers: 1,
      gifts: 1,
      checkedIn: 1,
      notCheckedIn: 1,
    });
    expect(m.checkInTimeline).toEqual([{ start: "2026-12-01T20:00:00.000Z", count: 1 }]);
  });

  it("sums large drop amounts exactly", async () => {
    const { event, tier } = await seed();
    const t = await soldTicket(event.id, tier.id);
    await offer(t, "PRIMARY", "ACCEPTED", "99999999999999999");
    await offer(t, "RESALE", "ACCEPTED", "99999999999999999");
    const m = await getEventMetrics(db, event.id);
    expect(m.primaryRevenueDrops).toBe("99999999999999999");
    expect(m.resaleVolumeDrops).toBe("99999999999999999");
  });

  it("ignores other events and handles an empty event", async () => {
    const a = await seed();
    const b = await seed();
    const t = await soldTicket(b.event.id, b.tier.id);
    await offer(t, "PRIMARY", "ACCEPTED", "2500000");
    const m = await getEventMetrics(db, a.event.id);
    expect(m).toMatchObject({ primarySold: 0, primaryRevenueDrops: "0", resales: 0, checkedIn: 0, checkInTimeline: [] });
  });
});
