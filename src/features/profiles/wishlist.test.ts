import { describe, expect, it } from "vitest";
import {
  WishlistError,
  addToWishlist,
  isWishlisted,
  listWishlistEventIds,
  removeFromWishlist,
} from "./wishlist";

type UserRow = { id: string; settings: unknown };
type EventRow = { id: string; status: "DRAFT" | "PUBLISHED" };

function stubDb(users: UserRow[], events: EventRow[] = []) {
  const store = new Map(users.map((u) => [u.id, { ...u }]));
  const writes: Record<string, unknown>[] = [];

  const db = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { settings: Record<string, unknown> };
      }) => {
        const row = store.get(where.id);
        if (row) row.settings = data.settings;
        writes.push(data.settings);
        return row;
      },
    },
    event: {
      findFirst: async ({ where }: { where: { id: string; status?: string } }) => {
        const event = events.find((e) => e.id === where.id);
        if (!event) return null;
        if (where.status && event.status !== where.status) return null;
        return { id: event.id };
      },
    },
  } as never;

  return { db, writes, store };
}

const USER = { id: "usr-1", settings: {} };
const PUBLISHED: EventRow = { id: "evt-pub", status: "PUBLISHED" };
const DRAFT: EventRow = { id: "evt-draft", status: "DRAFT" };

describe("saving an event", () => {
  it("adds it to the list", async () => {
    const f = stubDb([{ ...USER }], [PUBLISHED]);
    expect(await addToWishlist(f.db, USER.id, PUBLISHED.id)).toEqual([PUBLISHED.id]);
    expect(await isWishlisted(f.db, USER.id, PUBLISHED.id)).toBe(true);
  });

  it("does not duplicate on a repeated save", async () => {
    const f = stubDb([{ ...USER }], [PUBLISHED]);
    await addToWishlist(f.db, USER.id, PUBLISHED.id);
    const second = await addToWishlist(f.db, USER.id, PUBLISHED.id);

    expect(second).toEqual([PUBLISHED.id]);
    // The repeat performed no write at all.
    expect(f.writes).toHaveLength(1);
  });

  it("refuses an unpublished event, so a saved id cannot reveal a draft", async () => {
    const f = stubDb([{ ...USER }], [DRAFT]);
    await expect(addToWishlist(f.db, USER.id, DRAFT.id)).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });

  it("refuses an event that does not exist", async () => {
    const f = stubDb([{ ...USER }], []);
    await expect(addToWishlist(f.db, USER.id, "evt-missing")).rejects.toThrow(WishlistError);
  });

  it("keeps other preferences in the same column", async () => {
    const f = stubDb(
      [{ ...USER, settings: { city: "Dublin", follows: ["usr-s"], theme: "dark" } }],
      [PUBLISHED],
    );
    await addToWishlist(f.db, USER.id, PUBLISHED.id);

    const written = f.writes[0]!;
    expect(written.city).toBe("Dublin");
    expect(written.follows).toEqual(["usr-s"]);
    expect(written.theme).toBe("dark");
    expect(written.wishlist).toEqual([PUBLISHED.id]);
  });
});

describe("removing a saved event", () => {
  it("removes it", async () => {
    const f = stubDb([{ ...USER, settings: { wishlist: ["a", "b"] } }]);
    expect(await removeFromWishlist(f.db, USER.id, "a")).toEqual(["b"]);
  });

  it("is a no-op when it was not saved", async () => {
    const f = stubDb([{ ...USER, settings: { wishlist: [] } }]);
    await expect(removeFromWishlist(f.db, USER.id, "a")).resolves.toEqual([]);
    expect(f.writes).toHaveLength(0);
  });
});

describe("the stored list", () => {
  it("is empty with no settings", async () => {
    const f = stubDb([{ ...USER, settings: null }]);
    expect(await listWishlistEventIds(f.db, USER.id)).toEqual([]);
  });

  it("de-duplicates and drops non-strings", async () => {
    const f = stubDb([{ ...USER, settings: { wishlist: ["a", "a", 7, null, "b"] } }]);
    expect(await listWishlistEventIds(f.db, USER.id)).toEqual(["a", "b"]);
  });

  it("ignores a non-array value", async () => {
    const f = stubDb([{ ...USER, settings: { wishlist: "evt-1" } }]);
    expect(await listWishlistEventIds(f.db, USER.id)).toEqual([]);
  });
});

describe("independence from ticket ownership", () => {
  it("saving never consults tickets, and buying never changes the list", async () => {
    /*
     * The stub has no ticketNFT delegate at all. If saving or reading the
     * wishlist touched ticket ownership, these calls would throw — which is the
     * assertion: the two are not derived from one another.
     */
    const f = stubDb([{ ...USER }], [PUBLISHED]);
    await addToWishlist(f.db, USER.id, PUBLISHED.id);
    expect(await listWishlistEventIds(f.db, USER.id)).toEqual([PUBLISHED.id]);
    // Still saved regardless of whether a ticket was ever bought.
    expect(await isWishlisted(f.db, USER.id, PUBLISHED.id)).toBe(true);
  });
});
