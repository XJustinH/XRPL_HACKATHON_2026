import { describe, expect, it } from "vitest";
import { listPublishedEvents } from "@/features/events/event-store";

type FindManyArgs = { where: Record<string, unknown>; orderBy: unknown; take: number };

function stubDb() {
  const calls: FindManyArgs[] = [];
  const db = {
    event: {
      findMany: async (args: FindManyArgs) => {
        calls.push(args);
        return [];
      },
    },
  } as never;
  return { db, calls };
}

const NOW = new Date("2026-11-20T12:00:00.000Z");

describe("filters never widen what the public can see", () => {
  it("keeps the published-only filter whatever else is passed", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, {
      now: NOW,
      q: "anything",
      city: "Dublin",
      venue: "Vicar",
      sellerId: "usr-1",
    });
    expect(calls[0]!.where.status).toBe("PUBLISHED");
  });

  it("will not move the start-time floor into the past", async () => {
    // A crafted `from` must not surface events that have already started.
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, from: "2020-01-01T00:00:00.000Z" });
    expect(calls[0]!.where.startsAt).toEqual({ gt: NOW });
  });

  it("honours a future from date", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, from: "2026-12-01T00:00:00.000Z" });
    expect(calls[0]!.where.startsAt).toEqual({ gt: new Date("2026-12-01T00:00:00.000Z") });
  });

  it("applies both bounds when a range is given", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, {
      now: NOW,
      from: "2026-12-01T00:00:00.000Z",
      to: "2026-12-31T23:59:59.999Z",
    });
    expect(calls[0]!.where.startsAt).toEqual({
      gt: new Date("2026-12-01T00:00:00.000Z"),
      lte: new Date("2026-12-31T23:59:59.999Z"),
    });
  });

  it("ignores an unparseable date rather than dropping the floor", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, from: "nonsense", to: "also-nonsense" });
    expect(calls[0]!.where.startsAt).toEqual({ gt: NOW });
  });
});

describe("text filters", () => {
  it("matches free text against the title and description, case-insensitively", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, q: "Market" });
    expect(calls[0]!.where.OR).toEqual([
      { title: { contains: "Market", mode: "insensitive" } },
      { description: { contains: "Market", mode: "insensitive" } },
    ]);
  });

  it("matches a city exactly but ignoring case", async () => {
    // "dublin" and "Dublin" are the same city; "Dublin 8" is not.
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, city: "dublin" });
    expect(calls[0]!.where.city).toEqual({ equals: "dublin", mode: "insensitive" });
  });

  it("matches a venue as a partial, since names are typed loosely", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, venue: "vicar" });
    expect(calls[0]!.where.venue).toEqual({ contains: "vicar", mode: "insensitive" });
  });

  it("filters by organiser exactly", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW, sellerId: "usr-1" });
    expect(calls[0]!.where.sellerId).toBe("usr-1");
  });

  it("applies no text filter when none is given", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { now: NOW });
    expect(calls[0]!.where.OR).toBeUndefined();
    expect(calls[0]!.where.city).toBeUndefined();
    expect(calls[0]!.where.venue).toBeUndefined();
    expect(calls[0]!.where.sellerId).toBeUndefined();
  });
});

describe("filters combine with paging", () => {
  it("keeps the keyset alongside the filters", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, {
      now: NOW,
      city: "Dublin",
      cursor: Buffer.from("2026-12-01T20:00:00.000Z|evt-b", "utf8").toString("base64url"),
    });
    expect(calls[0]!.where.city).toEqual({ equals: "Dublin", mode: "insensitive" });
    expect(calls[0]!.where.OR).toBeDefined();
  });
});
