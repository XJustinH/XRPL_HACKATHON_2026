import { z } from "zod";

/**
 * Who may see a customer's attendance and saved events (XRPL-088), and the
 * rule that answers it for one event (XRPL-085, XRPL-086).
 *
 * **Opt-in by default.** The handoff requires community visibility to be
 * opt-in, so every default here is `ONLY_ME`: a customer who never opens these
 * settings is invisible to friends, not exposed by omission. Matching the
 * convention already used for `friendsVisibility` in XRPL-084.
 *
 * Per-event overrides exist because the global answer is often wrong for one
 * occasion — someone happy to share gigs may not want one event known. An
 * override always wins over the global setting, in either direction.
 */

/** Who can see a given kind of activity. No "everyone" option by design. */
export const ActivityVisibility = z.enum(["ONLY_ME", "FRIENDS"]);
export type ActivityVisibility = z.infer<typeof ActivityVisibility>;

export const PerEventVisibility = z.object({
  attendance: ActivityVisibility.optional(),
  wishlist: ActivityVisibility.optional(),
});
export type PerEventVisibility = z.infer<typeof PerEventVisibility>;

export const VisibilitySettings = z.object({
  attendanceVisibility: ActivityVisibility.default("ONLY_ME"),
  wishlistVisibility: ActivityVisibility.default("ONLY_ME"),
  /** Keyed by event id; only events the customer has changed appear here. */
  eventVisibility: z.record(z.string(), PerEventVisibility).default({}),
});
export type VisibilitySettings = z.infer<typeof VisibilitySettings>;

export const DEFAULT_VISIBILITY: VisibilitySettings = {
  attendanceVisibility: "ONLY_ME",
  wishlistVisibility: "ONLY_ME",
  eventVisibility: {},
};

/**
 * Reads visibility from a user's stored settings.
 *
 * Anything unparseable falls back to the private default. A corrupt or
 * partially-written row must never read as "shared" — failing open would
 * disclose activity the customer did not agree to share.
 */
export function readVisibilitySettings(settings: unknown): VisibilitySettings {
  if (!settings || typeof settings !== "object") return { ...DEFAULT_VISIBILITY };
  const source = settings as Record<string, unknown>;

  const attendance = ActivityVisibility.safeParse(source.attendanceVisibility);
  const wishlist = ActivityVisibility.safeParse(source.wishlistVisibility);

  // Per-event entries are salvaged individually, so one bad key cannot make a
  // whole profile public or wipe every other override.
  const perEvent: Record<string, PerEventVisibility> = {};
  const rawEvents = source.eventVisibility;
  if (rawEvents && typeof rawEvents === "object" && !Array.isArray(rawEvents)) {
    for (const [eventId, value] of Object.entries(rawEvents as Record<string, unknown>)) {
      const parsed = PerEventVisibility.safeParse(value);
      if (parsed.success && (parsed.data.attendance || parsed.data.wishlist)) {
        perEvent[eventId] = parsed.data;
      }
    }
  }

  return {
    attendanceVisibility: attendance.success ? attendance.data : "ONLY_ME",
    wishlistVisibility: wishlist.success ? wishlist.data : "ONLY_ME",
    eventVisibility: perEvent,
  };
}

export type ActivityKind = "attendance" | "wishlist";

/** The visibility that applies to one event: the override, else the global. */
export function effectiveVisibility(
  settings: VisibilitySettings,
  kind: ActivityKind,
  eventId: string,
): ActivityVisibility {
  const override = settings.eventVisibility[eventId]?.[kind];
  if (override) return override;
  return kind === "attendance" ? settings.attendanceVisibility : settings.wishlistVisibility;
}

/**
 * Whether `viewer` may see `owner`'s activity for one event.
 *
 * `areFriends` must already account for blocking: a blocked viewer is not a
 * friend. Checked here as well, so a caller that forgets cannot leak.
 */
export function canViewActivity(input: {
  ownerSettings: VisibilitySettings;
  kind: ActivityKind;
  eventId: string;
  viewerIsOwner: boolean;
  areFriends: boolean;
  isBlocked?: boolean;
}): boolean {
  // Your own activity is always visible to you.
  if (input.viewerIsOwner) return true;
  if (input.isBlocked) return false;

  const visibility = effectiveVisibility(input.ownerSettings, input.kind, input.eventId);
  if (visibility === "ONLY_ME") return false;
  return input.areFriends;
}

/**
 * Merges a visibility change into stored settings, preserving other keys.
 *
 * Clearing a per-event override is expressed by passing `null`, which removes
 * the entry so the global setting applies again — distinct from pinning it to
 * `ONLY_ME`, which keeps it private even if the global becomes shared.
 */
export function mergeVisibilitySettings(
  existing: unknown,
  patch: {
    attendanceVisibility?: ActivityVisibility;
    wishlistVisibility?: ActivityVisibility;
    event?: { eventId: string; kind: ActivityKind; value: ActivityVisibility | null };
  },
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const current = readVisibilitySettings(existing);
  const next: VisibilitySettings = {
    attendanceVisibility: patch.attendanceVisibility ?? current.attendanceVisibility,
    wishlistVisibility: patch.wishlistVisibility ?? current.wishlistVisibility,
    eventVisibility: { ...current.eventVisibility },
  };

  if (patch.event) {
    const { eventId, kind, value } = patch.event;
    const entry = { ...next.eventVisibility[eventId] };
    if (value === null) delete entry[kind];
    else entry[kind] = value;

    if (entry.attendance || entry.wishlist) next.eventVisibility[eventId] = entry;
    else delete next.eventVisibility[eventId];
  }

  return { ...base, ...next };
}
