import { beforeEach, describe, expect, it } from "vitest";
import {
  FollowError,
  followSeller,
  isFollowing,
  listFollowedSellerIds,
  unfollowSeller,
} from "./follows";

/**
 * Follows are stored as a list of ids in `User.settings`, so these tests use a
 * stub `user` delegate that records what would be written. The rules being
 * pinned are duplicate prevention and that other preferences in the same column
 * survive a follow.
 */

type Row = { id: string; role: string; settings: unknown };

function stubDb(rows: Row[]) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));
  const writes: Record<string, unknown>[] = [];

  const db = {
    user: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: unknown }) => {
        const row = store.get(where.id);
        if (!row) return null;
        void select;
        return row;
      },
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
    event: {},
  } as never;

  return { db, writes, store };
}

const CUSTOMER = { id: "usr-c", role: "CUSTOMER", settings: {} };
const SELLER = { id: "usr-s", role: "SELLER", settings: {} };
const ORGANISER = { id: "usr-o", role: "ORGANISER", settings: {} };

describe("following a seller", () => {
  let fixture: ReturnType<typeof stubDb>;

  beforeEach(() => {
    fixture = stubDb([{ ...CUSTOMER }, { ...SELLER }, { ...ORGANISER }]);
  });

  it("adds the seller", async () => {
    const follows = await followSeller(fixture.db, CUSTOMER.id, SELLER.id);
    expect(follows).toEqual([SELLER.id]);
    expect(await isFollowing(fixture.db, CUSTOMER.id, SELLER.id)).toBe(true);
  });

  it("allows following an organiser as well as a seller", async () => {
    await expect(followSeller(fixture.db, CUSTOMER.id, ORGANISER.id)).resolves.toEqual([
      ORGANISER.id,
    ]);
  });

  it("prevents duplicates: following twice is a no-op", async () => {
    await followSeller(fixture.db, CUSTOMER.id, SELLER.id);
    const second = await followSeller(fixture.db, CUSTOMER.id, SELLER.id);
    expect(second).toEqual([SELLER.id]);
    // The second call must not have written a doubled list.
    expect(fixture.writes).toHaveLength(1);
  });

  it("refuses to follow a customer account", async () => {
    const other = stubDb([{ ...CUSTOMER }, { id: "usr-c2", role: "CUSTOMER", settings: {} }]);
    await expect(followSeller(other.db, CUSTOMER.id, "usr-c2")).rejects.toThrow(FollowError);
  });

  it("refuses to follow an account that does not exist", async () => {
    await expect(followSeller(fixture.db, CUSTOMER.id, "usr-missing")).rejects.toMatchObject({
      code: "NOT_A_SELLER",
    });
  });

  it("refuses to follow yourself", async () => {
    await expect(followSeller(fixture.db, SELLER.id, SELLER.id)).rejects.toMatchObject({
      code: "CANNOT_FOLLOW_SELF",
    });
  });

  it("keeps other preferences in the same column", async () => {
    const withPrefs = stubDb([
      { ...CUSTOMER, settings: { city: "Dublin", interests: ["MUSIC"], theme: "dark" } },
      { ...SELLER },
    ]);
    await followSeller(withPrefs.db, CUSTOMER.id, SELLER.id);

    const written = withPrefs.writes[0]!;
    expect(written.city).toBe("Dublin");
    expect(written.interests).toEqual(["MUSIC"]);
    expect(written.theme).toBe("dark");
    expect(written.follows).toEqual([SELLER.id]);
  });
});

describe("unfollowing", () => {
  it("removes the seller", async () => {
    const fixture = stubDb([
      { ...CUSTOMER, settings: { follows: ["usr-s", "usr-o"] } },
      { ...SELLER },
    ]);
    const follows = await unfollowSeller(fixture.db, CUSTOMER.id, "usr-s");
    expect(follows).toEqual(["usr-o"]);
  });

  it("is a no-op when not following, rather than an error", async () => {
    const fixture = stubDb([{ ...CUSTOMER, settings: { follows: [] } }]);
    await expect(unfollowSeller(fixture.db, CUSTOMER.id, "usr-s")).resolves.toEqual([]);
    expect(fixture.writes).toHaveLength(0);
  });
});

describe("reading the stored list", () => {
  it("is empty for a user with no settings", async () => {
    const fixture = stubDb([{ ...CUSTOMER, settings: null }]);
    expect(await listFollowedSellerIds(fixture.db, CUSTOMER.id)).toEqual([]);
  });

  it("de-duplicates a hand-edited list", async () => {
    // A duplicated row must not produce a doubled entry in the UI.
    const fixture = stubDb([{ ...CUSTOMER, settings: { follows: ["a", "a", "b"] } }]);
    expect(await listFollowedSellerIds(fixture.db, CUSTOMER.id)).toEqual(["a", "b"]);
  });

  it("ignores non-string entries", async () => {
    const fixture = stubDb([{ ...CUSTOMER, settings: { follows: ["a", 42, null, { x: 1 }] } }]);
    expect(await listFollowedSellerIds(fixture.db, CUSTOMER.id)).toEqual(["a"]);
  });

  it("ignores a follows value that is not an array", async () => {
    const fixture = stubDb([{ ...CUSTOMER, settings: { follows: "usr-s" } }]);
    expect(await listFollowedSellerIds(fixture.db, CUSTOMER.id)).toEqual([]);
  });
});
