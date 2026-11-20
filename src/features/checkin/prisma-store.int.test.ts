import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/lib/db/client";
import { PrismaCheckInStore, PrismaTicketDirectory } from "./prisma-store";
import type { StoredChallenge } from "./ports";

/** XRPL-047 against real Postgres (`npm run db:up && npm run test:db`). */

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set");
const db = createPrismaClient(url);
const store = new PrismaCheckInStore(db);
const tickets = new PrismaTicketDirectory(db);

const NFT = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA2000000D1";
const ADDR = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

async function reset() {
  await db.$executeRawUnsafe(
    'TRUNCATE "CheckInRecord", "CheckInChallenge", "NFTOffer", "TicketNFT", "TicketTier", "Event", "WalletLink", "User" CASCADE',
  );
}

async function seed() {
  const seller = await db.user.create({ data: { displayName: "Seller", role: "SELLER" } });
  const organiser = await db.user.create({ data: { displayName: "Gate", role: "ORGANISER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "Dublin" },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "1000000", totalSupply: 1 } });
  const ticket = await db.ticketNFT.create({
    data: { eventId: event.id, tierId: tier.id, serial: 1, nftokenId: NFT, mintStatus: "MINTED" },
  });
  return { organiser, event, ticket };
}

function challenge(ticketId: string, eventId: string): StoredChallenge {
  return {
    id: randomUUID(),
    nonce: randomUUID(),
    ticketId,
    eventId,
    walletAddress: ADDR,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    proofReference: null,
  };
}

const record = (s: Awaited<ReturnType<typeof seed>>, challengeId: string) => ({
  ticketId: s.ticket.id,
  eventId: s.event.id,
  challengeId,
  organiserId: s.organiser.id,
  walletAddress: ADDR,
  verifiedLedgerIndex: 123,
  scannedAt: new Date(),
});

describe("PrismaCheckInStore", () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await db.$disconnect();
  });

  it("round-trips challenges and ticket lookups", async () => {
    const s = await seed();
    const c = challenge(s.ticket.id, s.event.id);
    await store.createChallenge(c);
    expect(await store.getChallenge(c.id)).toMatchObject({ id: c.id, walletAddress: ADDR, proofReference: null });
    expect(await tickets.findTicket(s.ticket.id)).toEqual({ ticketId: s.ticket.id, eventId: s.event.id, nftokenId: NFT });
    expect(await tickets.findTicket(randomUUID())).toBeNull();
  });

  it("markProven succeeds once", async () => {
    const s = await seed();
    const c = challenge(s.ticket.id, s.event.id);
    await store.createChallenge(c);
    expect(await store.markProven(c.id, "sha256:a")).toBe(true);
    expect(await store.markProven(c.id, "sha256:b")).toBe(false);
  });

  it("concurrent admissions with the same challenge admit exactly once", async () => {
    const s = await seed();
    const c = challenge(s.ticket.id, s.event.id);
    await store.createChallenge(c);
    const results = await Promise.all(Array.from({ length: 5 }, () => store.admitAtomically(record(s, c.id))));
    expect(results.filter((r) => r === "ADMITTED")).toHaveLength(1);
    expect(await db.checkInRecord.count()).toBe(1);
    expect(await store.hasCheckIn(s.ticket.id, s.event.id)).toBe(true);
  });

  it("two challenges for one ticket admit once and roll back the loser's challenge update", async () => {
    const s = await seed();
    const c1 = challenge(s.ticket.id, s.event.id);
    const c2 = challenge(s.ticket.id, s.event.id);
    await store.createChallenge(c1);
    await store.createChallenge(c2);
    const results = await Promise.all([store.admitAtomically(record(s, c1.id)), store.admitAtomically(record(s, c2.id))]);
    expect(results.sort()).toEqual(["ADMITTED", "TICKET_ALREADY_CHECKED_IN"]);
    const consumed = await db.checkInChallenge.count({ where: { consumedAt: { not: null } } });
    expect(consumed).toBe(1);
  });
});
