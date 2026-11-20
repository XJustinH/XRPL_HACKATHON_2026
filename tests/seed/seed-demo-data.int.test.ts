import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/lib/db/client";
import { DEMO_IDS, demoEvents, demoTiers, demoUsers } from "../../scripts/seed/fixtures";
import { SeedConflictError, seedDemoData } from "../../scripts/seed/seed-demo-data";

/**
 * XRPL-008 seed behaviour against a real Postgres (`npm run test:db`).
 * Shares the *_test database with src/lib/db/schema.int.test.ts; the db Vitest project runs
 * files one at a time so the truncation below cannot race with that suite.
 */

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set");
const db = createPrismaClient(url);

const counts = async () => ({
  users: await db.user.count(),
  events: await db.event.count(),
  tiers: await db.ticketTier.count(),
});

const fixtureCounts = { users: demoUsers.length, events: demoEvents.length, tiers: demoTiers.length };

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("seedDemoData", () => {
  it("creates the demo sellers, customers, events and tiers on an empty database", async () => {
    const summary = await seedDemoData(db);

    expect(summary).toEqual({
      users: { created: demoUsers.length, existing: 0 },
      events: { created: demoEvents.length, existing: 0 },
      tiers: { created: demoTiers.length, existing: 0 },
    });
    expect(await counts()).toEqual(fixtureCounts);

    const customer = await db.user.findUniqueOrThrow({ where: { id: DEMO_IDS.users.customer } });
    expect(customer.role).toBe("CUSTOMER");
    const headline = await db.event.findUniqueOrThrow({
      where: { id: DEMO_IDS.events.headlineShow },
      include: { tiers: true, seller: true },
    });
    expect(headline.status).toBe("PUBLISHED");
    expect(headline.seller.role).toBe("SELLER");
    expect(headline.tiers.map((t) => t.name).sort()).toEqual(["General Admission", "VIP"]);
    expect(headline.tiers.every((t) => t.mintedQuantity === 0)).toBe(true);
  });

  it("is idempotent: a second run creates no duplicates", async () => {
    await seedDemoData(db);
    const second = await seedDemoData(db);

    expect(second).toEqual({
      users: { created: 0, existing: demoUsers.length },
      events: { created: 0, existing: demoEvents.length },
      tiers: { created: 0, existing: demoTiers.length },
    });
    expect(await counts()).toEqual(fixtureCounts);
  });

  it("does not duplicate records when two runs overlap", async () => {
    const results = await Promise.allSettled([seedDemoData(db), seedDemoData(db)]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await counts()).toEqual(fixtureCounts);
  });

  it("leaves existing demo records as the app left them", async () => {
    await seedDemoData(db);
    await db.event.update({ where: { id: DEMO_IDS.events.openMicNight }, data: { status: "DRAFT", publishedAt: null } });
    await db.ticketTier.update({ where: { id: DEMO_IDS.tiers.headlineVip }, data: { mintedQuantity: 1 } });

    await seedDemoData(db);

    const event = await db.event.findUniqueOrThrow({ where: { id: DEMO_IDS.events.openMicNight } });
    expect(event.status).toBe("DRAFT");
    expect(event.publishedAt).toBeNull();
    const tier = await db.ticketTier.findUniqueOrThrow({ where: { id: DEMO_IDS.tiers.headlineVip } });
    expect(tier.mintedQuantity).toBe(1);
  });

  it("does not modify or remove records it does not own", async () => {
    const other = await db.user.create({ data: { displayName: "Real user", role: "CUSTOMER" } });

    await seedDemoData(db);

    expect(await db.user.findUniqueOrThrow({ where: { id: other.id } })).toEqual(other);
    expect(await db.user.count()).toBe(demoUsers.length + 1);
  });

  it("seeds no wallet links, ticket NFTs, offers or ledger transactions", async () => {
    await seedDemoData(db);

    expect(await db.walletLink.count()).toBe(0);
    expect(await db.ticketNFT.count()).toBe(0);
    expect(await db.nFTOffer.count()).toBe(0);
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("fails loudly and writes nothing when a fixture clashes with an existing record", async () => {
    // A tier named like a fixture tier, on a demo event, but under a different ID.
    const [artist] = demoUsers;
    const [headline] = demoEvents;
    await db.user.create({ data: artist });
    await db.event.create({ data: headline });
    await db.ticketTier.create({
      data: { eventId: headline.id, name: "General Admission", priceDrops: "1", totalSupply: 1 },
    });

    const error = await seedDemoData(db).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SeedConflictError);
    expect((error as SeedConflictError).missingIds).toEqual([DEMO_IDS.tiers.headlineGeneralAdmission]);
    // The whole run rolled back: no other demo record was inserted.
    expect(await counts()).toEqual({ users: 1, events: 1, tiers: 1 });
  });
});
