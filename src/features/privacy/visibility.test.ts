import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIBILITY,
  canViewActivity,
  effectiveVisibility,
  mergeVisibilitySettings,
  readVisibilitySettings,
} from "./visibility";

/**
 * These are the rules that decide whether one customer's activity is disclosed
 * to another, so the tests are written as disclosure checks: the default
 * assertion is that nothing is shared unless it was explicitly opted into.
 */

const EVENT = "evt-1";

describe("defaults are private, as the handoff requires", () => {
  it("defaults both kinds to ONLY_ME", () => {
    expect(DEFAULT_VISIBILITY.attendanceVisibility).toBe("ONLY_ME");
    expect(DEFAULT_VISIBILITY.wishlistVisibility).toBe("ONLY_ME");
  });

  it("reads an absent or empty settings column as private", () => {
    for (const input of [null, undefined, {}, "", 7, []]) {
      expect(readVisibilitySettings(input)).toEqual(DEFAULT_VISIBILITY);
    }
  });

  it("hides activity from a friend who was never opted in", () => {
    expect(
      canViewActivity({
        ownerSettings: readVisibilitySettings({}),
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: false,
        areFriends: true,
      }),
    ).toBe(false);
  });
});

describe("corrupt settings fail closed", () => {
  it("falls back to private for an unknown value, never to shared", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "EVERYONE",
      wishlistVisibility: 42,
    });
    expect(settings.attendanceVisibility).toBe("ONLY_ME");
    expect(settings.wishlistVisibility).toBe("ONLY_ME");
  });

  it("salvages per-event overrides individually", () => {
    // One bad key must not discard the others, nor widen anything.
    const settings = readVisibilitySettings({
      eventVisibility: {
        good: { attendance: "FRIENDS" },
        bad: { attendance: "EVERYONE" },
        alsoBad: "nonsense",
      },
    });
    expect(settings.eventVisibility.good).toEqual({ attendance: "FRIENDS" });
    expect(settings.eventVisibility.bad).toBeUndefined();
    expect(settings.eventVisibility.alsoBad).toBeUndefined();
  });

  it("ignores an eventVisibility that is an array rather than an object", () => {
    expect(readVisibilitySettings({ eventVisibility: ["evt-1"] }).eventVisibility).toEqual({});
  });
});

describe("per-event overrides win over the global setting", () => {
  const shared = readVisibilitySettings({ attendanceVisibility: "FRIENDS" });

  it("can hide a single event while sharing in general", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "FRIENDS",
      eventVisibility: { [EVENT]: { attendance: "ONLY_ME" } },
    });
    expect(effectiveVisibility(settings, "attendance", EVENT)).toBe("ONLY_ME");
    expect(effectiveVisibility(settings, "attendance", "other")).toBe("FRIENDS");
  });

  it("can share a single event while private in general", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "ONLY_ME",
      eventVisibility: { [EVENT]: { attendance: "FRIENDS" } },
    });
    expect(effectiveVisibility(settings, "attendance", EVENT)).toBe("FRIENDS");
    expect(effectiveVisibility(settings, "attendance", "other")).toBe("ONLY_ME");
  });

  it("keeps the two kinds independent", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "FRIENDS",
      wishlistVisibility: "ONLY_ME",
    });
    expect(effectiveVisibility(settings, "attendance", EVENT)).toBe("FRIENDS");
    expect(effectiveVisibility(settings, "wishlist", EVENT)).toBe("ONLY_ME");
  });

  it("falls through to the global when only the other kind is overridden", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "FRIENDS",
      eventVisibility: { [EVENT]: { wishlist: "ONLY_ME" } },
    });
    expect(effectiveVisibility(settings, "attendance", EVENT)).toBe("FRIENDS");
    expect(effectiveVisibility(shared, "attendance", EVENT)).toBe("FRIENDS");
  });
});

describe("canViewActivity", () => {
  const shared = readVisibilitySettings({ attendanceVisibility: "FRIENDS" });

  it("always shows a customer their own activity", () => {
    const privateSettings = readVisibilitySettings({});
    expect(
      canViewActivity({
        ownerSettings: privateSettings,
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: true,
        areFriends: false,
      }),
    ).toBe(true);
  });

  it("shows a friend only when sharing is on", () => {
    expect(
      canViewActivity({
        ownerSettings: shared,
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: false,
        areFriends: true,
      }),
    ).toBe(true);
  });

  it("hides from a stranger even when sharing is on", () => {
    expect(
      canViewActivity({
        ownerSettings: shared,
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: false,
        areFriends: false,
      }),
    ).toBe(false);
  });

  it("hides from a blocked viewer who is otherwise a friend", () => {
    // Belt and braces: callers should exclude blocked users from `areFriends`,
    // but forgetting that must not leak.
    expect(
      canViewActivity({
        ownerSettings: shared,
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: false,
        areFriends: true,
        isBlocked: true,
      }),
    ).toBe(false);
  });

  it("respects a per-event opt-out for a friend", () => {
    const settings = readVisibilitySettings({
      attendanceVisibility: "FRIENDS",
      eventVisibility: { [EVENT]: { attendance: "ONLY_ME" } },
    });
    expect(
      canViewActivity({
        ownerSettings: settings,
        kind: "attendance",
        eventId: EVENT,
        viewerIsOwner: false,
        areFriends: true,
      }),
    ).toBe(false);
  });
});

describe("mergeVisibilitySettings", () => {
  it("preserves unrelated preferences in the shared column", () => {
    const merged = mergeVisibilitySettings(
      { city: "Dublin", follows: ["usr-s"], friendsVisibility: "FRIENDS" },
      { attendanceVisibility: "FRIENDS" },
    );
    expect(merged.city).toBe("Dublin");
    expect(merged.follows).toEqual(["usr-s"]);
    expect(merged.friendsVisibility).toBe("FRIENDS");
    expect(merged.attendanceVisibility).toBe("FRIENDS");
  });

  it("sets and clears a per-event override", () => {
    const set = mergeVisibilitySettings(
      {},
      { event: { eventId: EVENT, kind: "attendance", value: "FRIENDS" } },
    );
    expect((set.eventVisibility as Record<string, unknown>)[EVENT]).toEqual({
      attendance: "FRIENDS",
    });

    const cleared = mergeVisibilitySettings(set, {
      event: { eventId: EVENT, kind: "attendance", value: null },
    });
    // Cleared means "use the global again", not "pinned private".
    expect((cleared.eventVisibility as Record<string, unknown>)[EVENT]).toBeUndefined();
  });

  it("distinguishes clearing from pinning to private", () => {
    const pinned = mergeVisibilitySettings(
      { attendanceVisibility: "FRIENDS" },
      { event: { eventId: EVENT, kind: "attendance", value: "ONLY_ME" } },
    );
    const settings = readVisibilitySettings(pinned);
    // Pinned stays private even though the global is shared.
    expect(effectiveVisibility(settings, "attendance", EVENT)).toBe("ONLY_ME");
  });

  it("keeps the other kind when clearing one", () => {
    const both = mergeVisibilitySettings(
      {},
      { event: { eventId: EVENT, kind: "attendance", value: "FRIENDS" } },
    );
    const withWishlist = mergeVisibilitySettings(both, {
      event: { eventId: EVENT, kind: "wishlist", value: "FRIENDS" },
    });
    const cleared = mergeVisibilitySettings(withWishlist, {
      event: { eventId: EVENT, kind: "attendance", value: null },
    });
    expect((cleared.eventVisibility as Record<string, unknown>)[EVENT]).toEqual({
      wishlist: "FRIENDS",
    });
  });
});
