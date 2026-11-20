import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { PrismaAttendance } from "./attendance";

/** XRPL-079 attendance proof against Postgres (`npm run test:db`). */

const db = getDb();
const attendance = new PrismaAttendance(db);
const hex = (p: string, n: number) => (p + n.toString(16)).toUpperCase().padStart(64, "0");
const ALICE_WALLET = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const OTHER_WALLET = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const alice = await db.user.create({ data: { displayName: "Alice", role: "CUSTOMER" } });
  const mk = (title: string) =>
    db.event.create({ data: { sellerId: seller.id, title, startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "C", status: "PUBLISHED" } });
  const event = await mk("Gig");
  const other = await mk("Other gig");
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "1000000", totalSupply: 1 } });
  const ticket = await db.ticketNFT.create({
    data: { eventId: event.id, tierId: tier.id, serial: 1, mintStatus: "MINTED", nftokenId: hex("A", 1), mintTxHash: hex("B", 1), mintedAt: new Date() },
  });
  const checkIn = (wallet: string) =>
    db.checkInRecord.create({ data: { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: wallet } });
  const link = (address: string, opts: { verified?: boolean; revoked?: boolean } = {}) =>
    db.walletLink.create({
      data: {
        userId: alice.id,
        address,
        verifiedAt: opts.verified === false ? null : new Date(),
        revokedAt: opts.revoked ? new Date() : null,
      },
    });
  return { alice, event, other, checkIn, link };
}

describe("PrismaAttendance", () => {
  it("finds the check-in of one of the user's verified wallets", async () => {
    const s = await seed();
    await s.link(ALICE_WALLET);
    const rec = await s.checkIn(ALICE_WALLET);
    expect(await attendance.findAttendance(s.alice.id, s.event.id)).toEqual({ checkInRecordId: rec.id });
    expect(await attendance.findAttendance(s.alice.id, s.other.id)).toBeNull();
  });

  it("ignores unverified and revoked wallets", async () => {
    const s = await seed();
    await s.checkIn(ALICE_WALLET);
    await s.link(ALICE_WALLET, { verified: false });
    expect(await attendance.findAttendance(s.alice.id, s.event.id)).toBeNull();

    await db.walletLink.deleteMany();
    await s.link(ALICE_WALLET, { revoked: true });
    expect(await attendance.findAttendance(s.alice.id, s.event.id)).toBeNull();
  });

  it("does not count someone else's check-in", async () => {
    const s = await seed();
    await s.link(ALICE_WALLET);
    await s.checkIn(OTHER_WALLET);
    expect(await attendance.findAttendance(s.alice.id, s.event.id)).toBeNull();
  });

  it("returns null for a user with no wallets", async () => {
    const s = await seed();
    await s.checkIn(ALICE_WALLET);
    expect(await attendance.findAttendance(s.alice.id, s.event.id)).toBeNull();
  });
});
