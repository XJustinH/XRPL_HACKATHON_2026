import { describe, expect, it } from "vitest";
import { encodeEventCursor, listPublishedEvents } from "./event-store";

/**
 * The listing query is exercised through a stub `event.findMany`, so the filter
 * and keyset it builds can be asserted without a database. The rules being
 * pinned here are the ones that would leak a draft or break paging.
 */

type FindManyArgs = {
  where: Record<string, unknown>;
  orderBy: unknown;
  take: number;
};

function stubDb(rows: unknown[]) {
  const calls: FindManyArgs[] = [];
  const db = {
    event: {
      findMany: async (args: FindManyArgs) => {
        calls.push(args);
        return rows;
      },
    },
  } as never;
  return { db, calls };
}

function row(id: string, startsAt: string) {
  return {
    id,
    sellerId: "usr-1",
    title: `Event ${id}`,
    description: "",
    startsAt: new Date(startsAt),
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "PUBLISHED" as const,
    artworkUrl: null,
    publishedAt: new Date("2026-11-01T00:00:00.000Z"),
    createdAt: new Date("2026-11-01T00:00:00.000Z"),
    updatedAt: new Date("2026-11-01T00:00:00.000Z"),
    seller: { id: "usr-1", displayName: "Night Market", role: "SELLER" },
    tiers: [],
  };
}

const NOW = new Date("2026-11-20T12:00:00.000Z");

describe("listPublishedEvents", () => {
  it("asks only for published events that have not started", async () => {
    const { db, calls } = stubDb([]);
    await listPublishedEvents(db, { now: NOW });

    expect(calls[0]!.where).toMatchObject({
      status: "PUBLISHED",
      startsAt: { gt: NOW },
    });
  });

  it("sorts by start time then id, so the keyset is total", async () => {
    const { db, calls } = stubDb([]);
    await listPublishedEvents(db, { now: NOW });
    expect(calls[0]!.orderBy).toEqual([{ startsAt: "asc" }, { id: "asc" }]);
  });

  it("requests one extra row to detect a further page", async () => {
    const { db, calls } = stubDb([]);
    await listPublishedEvents(db, { now: NOW, limit: 12 });
    expect(calls[0]!.take).toBe(13);
  });

  it("returns a cursor only when another page exists", async () => {
    const two = [row("a", "2026-12-01T20:00:00.000Z"), row("b", "2026-12-02T20:00:00.000Z")];

    const exact = stubDb(two);
    const full = await listPublishedEvents(exact.db, { now: NOW, limit: 2 });
    expect(full.items).toHaveLength(2);
    expect(full.nextCursor).toBeNull();

    const overflowing = stubDb([...two, row("c", "2026-12-03T20:00:00.000Z")]);
    const page = await listPublishedEvents(overflowing.db, { now: NOW, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("builds a keyset that skips ties on the same start time", async () => {
    const cursor = encodeEventCursor({ id: "evt-b", startsAt: "2026-12-01T20:00:00.000Z" });
    const { db, calls } = stubDb([]);
    await listPublishedEvents(db, { now: NOW, cursor });

    // Either a later start time, or the same start time with a greater id.
    expect(calls[0]!.where).toMatchObject({
      OR: [
        { startsAt: { gt: new Date("2026-12-01T20:00:00.000Z") } },
        { startsAt: new Date("2026-12-01T20:00:00.000Z"), id: { gt: "evt-b" } },
      ],
    });
  });

  it("treats an unreadable cursor as no cursor rather than failing", async () => {
    for (const bad of ["not-base64!!", "", Buffer.from("no-separator").toString("base64url")]) {
      const { db, calls } = stubDb([]);
      await expect(listPublishedEvents(db, { now: NOW, cursor: bad })).resolves.toBeTruthy();
      expect(calls[0]!.where).not.toHaveProperty("OR");
    }
  });

  it("never returns a status filter the caller could widen", async () => {
    const { db, calls } = stubDb([]);
    // @ts-expect-error -- proving the option does not exist
    await listPublishedEvents(db, { now: NOW, status: "DRAFT" });
    expect(calls[0]!.where.status).toBe("PUBLISHED");
  });

  it("caps an oversized page size", async () => {
    const huge = stubDb([]);
    await listPublishedEvents(huge.db, { now: NOW, limit: 9_999 });
    expect(huge.calls[0]!.take).toBe(51);
  });

  it("raises a non-positive page size to one rather than fetching nothing", async () => {
    const zero = stubDb([]);
    await listPublishedEvents(zero.db, { now: NOW, limit: 0 });
    expect(zero.calls[0]!.take).toBe(2);

    const negative = stubDb([]);
    await listPublishedEvents(negative.db, { now: NOW, limit: -5 });
    expect(negative.calls[0]!.take).toBe(2);
  });

  it("uses the default page size when none is given", async () => {
    const { db, calls } = stubDb([]);
    await listPublishedEvents(db, { now: NOW });
    expect(calls[0]!.take).toBe(13);
  });
});

describe("encodeEventCursor", () => {
  it("produces a URL-safe opaque value", () => {
    const cursor = encodeEventCursor({ id: "evt-1", startsAt: "2026-12-01T20:00:00.000Z" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("evt-1");
  });

  it("differs per event so two rows never share a cursor", () => {
    const a = encodeEventCursor({ id: "evt-1", startsAt: "2026-12-01T20:00:00.000Z" });
    const b = encodeEventCursor({ id: "evt-2", startsAt: "2026-12-01T20:00:00.000Z" });
    expect(a).not.toBe(b);
  });
});
