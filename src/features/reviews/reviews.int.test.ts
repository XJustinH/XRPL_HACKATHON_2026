import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";
import { PrismaAttendance } from "./attendance";
import { PrismaReviewStore } from "./prisma-store";
import { ReviewService } from "./review-service";

/** XRPL-079 end to end on Postgres: real attendance check + Agent A's Review table (`npm run test:db`). */

const db = getDb();
const svc = new ReviewService({ attendance: new PrismaAttendance(db), store: new PrismaReviewStore(db) });
const hex = (p: string, n: number) => (p + n.toString(16)).toUpperCase().padStart(64, "0");
const WALLETS = ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "rPEPPER7kfTD9w2To4CQk6UCfuHM9c6GDY", "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"];
const code = (p: Promise<unknown>) =>
  p.then(() => "OK", (e: unknown) => (e instanceof AppError ? `${e.status} ${e.code}` : `DB ${(e as { code?: string }).code ?? e}`));

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Review","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

/** An event with `attendees` customers who each hold a verified wallet that was checked in. */
async function seed(attendees: number, extraCustomers = 0) {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: { sellerId: seller.id, title: "Gig", startsAt: new Date("2026-12-01T20:00:00Z"), venue: "V", city: "C", status: "PUBLISHED" },
  });
  const tier = await db.ticketTier.create({ data: { eventId: event.id, name: "GA", priceDrops: "1000000", totalSupply: 5 } });
  const users = [];
  for (let i = 0; i < attendees + extraCustomers; i += 1) {
    const user = await db.user.create({ data: { displayName: `Fan ${i + 1}`, role: "CUSTOMER" } });
    await db.walletLink.create({ data: { userId: user.id, address: WALLETS[i]!, verifiedAt: new Date() } });
    if (i < attendees) {
      const ticket = await db.ticketNFT.create({
        data: {
          eventId: event.id,
          tierId: tier.id,
          serial: i + 1,
          mintStatus: "MINTED",
          nftokenId: hex("A", i + 1),
          mintTxHash: hex("B", i + 1),
          mintedAt: new Date(),
        },
      });
      await db.checkInRecord.create({
        data: { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: WALLETS[i]! },
      });
    }
    users.push(user);
  }
  return { event, users };
}

describe("reviews on Postgres", () => {
  it("attendees review once, edit, and everyone sees the list and average", async () => {
    const { event, users } = await seed(2);
    const a = users[0]!;
    const b = users[1]!;
    await svc.create(a.id, event.id, { rating: 5, body: "Brilliant" });
    await svc.create(b.id, event.id, { rating: 4, body: "" });
    await svc.updateOwn(b.id, event.id, { rating: 3, body: "Sound was quiet" });

    const list = await svc.list(event.id, null);
    expect(list).toMatchObject({ count: 2, averageRating: 4, viewer: { status: "NOT_SIGNED_IN" } });
    expect(list.reviews.map((r) => r.author.displayName).sort()).toEqual(["Fan 1", "Fan 2"]);
    expect(list.reviews.find((r) => r.author.id === b.id)).toMatchObject({ rating: 3, body: "Sound was quiet" });

    const row = await db.review.findUniqueOrThrow({ where: { eventId_authorId: { eventId: event.id, authorId: a.id } } });
    expect(row.checkInRecordId).not.toBeNull(); // proof of attendance is recorded
  });

  it("rejects a customer who was not checked in, and writes nothing", async () => {
    const { event, users } = await seed(1, 1);
    expect(await code(svc.create(users[1]!.id, event.id, { rating: 5, body: "" }))).toBe("403 NOT_ATTENDED");
    expect(await db.review.count()).toBe(0);
  });

  it("one review per customer per event, even when two tabs post at once", async () => {
    const { event, users } = await seed(1);
    const id = users[0]!.id;
    const results = await Promise.all([
      code(svc.create(id, event.id, { rating: 5, body: "" })),
      code(svc.create(id, event.id, { rating: 1, body: "" })),
    ]);
    expect(results.sort()).toEqual(["409 ALREADY_REVIEWED", "OK"]);
    expect(await db.review.count()).toBe(1);
  });

  it("hidden reviews are excluded from the list and the average", async () => {
    const { event, users } = await seed(2);
    await svc.create(users[0]!.id, event.id, { rating: 5, body: "" });
    const low = await svc.create(users[1]!.id, event.id, { rating: 1, body: "spam" });
    await db.review.update({ where: { id: low.id }, data: { hiddenAt: new Date() } });
    expect(await svc.list(event.id, null)).toMatchObject({ count: 1, averageRating: 5 });
  });

  it("the database itself refuses out-of-range ratings", async () => {
    const { event, users } = await seed(1);
    const err = await db.review
      .create({ data: { eventId: event.id, authorId: users[0]!.id, rating: 6 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await db.review.count()).toBe(0);
  });

  it("reports who may review", async () => {
    const { event, users } = await seed(1, 1);
    expect((await svc.list(event.id, users[0]!.id)).viewer).toEqual({ status: "CAN_REVIEW" });
    expect((await svc.list(event.id, users[1]!.id)).viewer).toEqual({ status: "NOT_ATTENDED" });
  });
});
