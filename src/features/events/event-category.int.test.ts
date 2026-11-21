import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { createEventDraft, listPublishedEvents, updateEvent } from "./event-store";

/**
 * Event categories against Postgres (XRPL-015, XRPL-059): the seller's choice is stored, can be
 * changed or cleared, and the public search filters on it.
 */

const db = getDb();

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE "Event","User" CASCADE`);
});

afterAll(async () => {
  await db.$disconnect();
});

async function seller() {
  return db.user.create({ data: { displayName: "Venue", role: "SELLER", onboardedAt: new Date() } });
}

const draft = (title: string, category?: "MUSIC" | "COMEDY" | null) => ({
  title,
  description: "",
  startsAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  endsAt: null,
  venue: "Vicar St",
  city: "Dublin",
  ...(category === undefined ? {} : { category }),
});

async function published(sellerId: string, title: string, category?: "MUSIC" | "COMEDY" | null) {
  const event = await createEventDraft(db, sellerId, draft(title, category));
  await db.event.update({ where: { id: event.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  return event;
}

describe("event categories", () => {
  it("stores the seller's category, leaves it alone on unrelated edits, and clears it", async () => {
    const { id: sellerId } = await seller();
    const created = await createEventDraft(db, sellerId, draft("Gig", "MUSIC"));
    expect(created.category).toBe("MUSIC");
    expect((await createEventDraft(db, sellerId, draft("Talk"))).category).toBeNull();

    expect((await updateEvent(db, created.id, { title: "Gig (late show)" })).category).toBe("MUSIC");
    expect((await updateEvent(db, created.id, { category: "COMEDY" })).category).toBe("COMEDY");
    expect((await updateEvent(db, created.id, { category: null })).category).toBeNull();
  });

  it("filters published events by category", async () => {
    const { id: sellerId } = await seller();
    await published(sellerId, "Band night", "MUSIC");
    await published(sellerId, "Stand-up", "COMEDY");
    await published(sellerId, "Uncategorised");
    await createEventDraft(db, sellerId, draft("Draft gig", "MUSIC")); // never public

    const titles = async (category?: "MUSIC" | "COMEDY") =>
      (await listPublishedEvents(db, category ? { category } : {})).items.map((e) => e.title).sort();
    expect(await titles("MUSIC")).toEqual(["Band night"]);
    expect(await titles("COMEDY")).toEqual(["Stand-up"]);
    expect(await titles()).toEqual(["Band night", "Stand-up", "Uncategorised"]);
  });

  it("reads a stored value outside the vocabulary as no category", async () => {
    const { id: sellerId } = await seller();
    const event = await published(sellerId, "Old import");
    await db.event.update({ where: { id: event.id }, data: { category: "Opera" } });
    expect((await listPublishedEvents(db, {})).items[0]?.category).toBeNull();
  });
});
