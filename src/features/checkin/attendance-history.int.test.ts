import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { listAttendedEvents, prismaAttendancePort } from "./attendance-history";

/** Attended-event history for the profile (XRPL-056) and AttendancePort, against Postgres. */

const db = getDb();
const hex = (p: string, n: number) => (p + n.toString(16)).toUpperCase().padStart(64, "0");
const MINE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const MY_OTHER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const THEIRS = "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY";
let serial = 0;

beforeEach(async () => {
  serial = 0;
  await db.$executeRawUnsafe(
    `TRUNCATE "Review","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function setup() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const me = await db.user.create({ data: { displayName: "Me", role: "CUSTOMER" } });
  const event = async (title: string, startsAt: string) => {
    const e = await db.event.create({
      data: { sellerId: seller.id, title, startsAt: new Date(startsAt), venue: "Vicar St", city: "Dublin", status: "PUBLISHED" },
    });
    const tier = await db.ticketTier.create({ data: { eventId: e.id, name: "GA", priceDrops: "1000000", totalSupply: 5 } });
    return { ...e, tierId: tier.id };
  };
  const checkIn = async (e: { id: string; tierId: string }, wallet: string, at: string) => {
    serial += 1;
    const ticket = await db.ticketNFT.create({
      data: { eventId: e.id, tierId: e.tierId, serial, mintStatus: "MINTED", nftokenId: hex("A", serial), mintTxHash: hex("B", serial), mintedAt: new Date() },
    });
    await db.checkInRecord.create({
      data: { ticketId: ticket.id, eventId: e.id, organiserId: seller.id, walletAddress: wallet, scannedAt: new Date(at) },
    });
  };
  return { me, event, checkIn };
}

describe("listAttendedEvents", () => {
  it("lists events checked in with any of my verified wallets, newest event first, once each", async () => {
    const { me, event, checkIn } = await setup();
    await db.walletLink.create({ data: { userId: me.id, address: MINE, verifiedAt: new Date() } });
    await db.walletLink.create({ data: { userId: me.id, address: MY_OTHER, verifiedAt: new Date() } });
    const older = await event("Older gig", "2026-10-01T20:00:00Z");
    const newer = await event("Newer gig", "2026-11-01T20:00:00Z");
    const notMine = await event("Someone else's gig", "2026-11-15T20:00:00Z");
    await checkIn(older, MINE, "2026-10-01T19:00:00Z");
    await checkIn(newer, MY_OTHER, "2026-11-01T19:10:00Z");
    await checkIn(newer, MINE, "2026-11-01T19:30:00Z"); // second ticket, same event
    await checkIn(notMine, THEIRS, "2026-11-15T19:00:00Z");

    const list = await listAttendedEvents(db, me.id);
    expect(list.map((e) => e.title)).toEqual(["Newer gig", "Older gig"]);
    expect(list[0]).toMatchObject({ venue: "Vicar St", city: "Dublin", checkedInAt: "2026-11-01T19:10:00.000Z" });
    expect(await prismaAttendancePort(db).listAttendedEventIds(me.id)).toEqual([newer.id, older.id]);
  });

  it("ignores unverified and revoked wallets, and users with none", async () => {
    const { me, event, checkIn } = await setup();
    const gig = await event("Gig", "2026-10-01T20:00:00Z");
    await checkIn(gig, MINE, "2026-10-01T19:00:00Z");
    expect(await listAttendedEvents(db, me.id)).toEqual([]);

    await db.walletLink.create({ data: { userId: me.id, address: MINE, verifiedAt: null } });
    expect(await listAttendedEvents(db, me.id)).toEqual([]);

    await db.walletLink.updateMany({ where: { userId: me.id }, data: { verifiedAt: new Date(), revokedAt: new Date() } });
    expect(await listAttendedEvents(db, me.id)).toEqual([]);
  });

  it("respects the limit", async () => {
    const { me, event, checkIn } = await setup();
    await db.walletLink.create({ data: { userId: me.id, address: MINE, verifiedAt: new Date() } });
    for (let i = 1; i <= 3; i += 1) await checkIn(await event(`Gig ${i}`, `2026-0${i}-01T20:00:00Z`), MINE, `2026-0${i}-01T19:00:00Z`);
    expect((await listAttendedEvents(db, me.id, 2)).map((e) => e.title)).toEqual(["Gig 3", "Gig 2"]);
  });
});
