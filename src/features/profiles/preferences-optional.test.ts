import { describe, expect, it } from "vitest";
import { listPublishedEvents } from "@/features/events/event-store";
import { readProfileSettings } from "./profile-settings";

/**
 * Preferences are opt-in, so "none set" is a normal state rather than an
 * incomplete one. These tests pin the third acceptance criterion of XRPL-058:
 * event browsing still works when preferences are skipped.
 */

type FindManyArgs = { where: Record<string, unknown>; orderBy: unknown; take: number };

function stubDb(rows: unknown[] = []) {
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

describe("an account with no preferences", () => {
  it("reads as empty rather than missing", () => {
    const settings = readProfileSettings({});
    expect(settings.interests).toEqual([]);
    expect(settings.city).toBeNull();
  });

  it("is indistinguishable from a brand-new account", () => {
    expect(readProfileSettings(null)).toEqual(readProfileSettings({}));
  });
});

describe("the public listing ignores preferences entirely", () => {
  it("takes no interests or city parameter", async () => {
    const { db, calls } = stubDb();
    await listPublishedEvents(db, {});

    // Nothing preference-shaped reaches the query, so a signed-out or
    // preference-free visitor sees the same published events as anyone else.
    const where = JSON.stringify(calls[0]!.where);
    expect(where).not.toMatch(/interest/i);
    expect(where).not.toMatch(/city/i);
    expect(calls[0]!.where).toMatchObject({ status: "PUBLISHED" });
  });

  it("returns a page with the same shape regardless of preferences", async () => {
    const { db } = stubDb();
    const page = await listPublishedEvents(db, {});
    expect(page).toHaveProperty("items");
    expect(page).toHaveProperty("nextCursor");
  });
});
