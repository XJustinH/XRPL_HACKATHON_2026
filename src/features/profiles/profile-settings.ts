import { z } from "zod";
import { EVENT_CATEGORIES, EventCategory, ProfileVisibility, SocialLink } from "@/contracts";

/**
 * Stored interests, filtered to the categories this version knows about.
 *
 * A selection saved against a category that has since been renamed or removed
 * is dropped rather than failing the whole profile read, so an old preference
 * never blocks a page from rendering.
 */
const StoredInterests = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is EventCategory => EventCategory.safeParse(value).success),
  );

/**
 * Typed view of the non-sensitive preferences stored in `User.settings`.
 *
 * The schema reserves that column for "non-sensitive preferences only (UI,
 * opt-ins)", which is exactly what a public profile blurb, links, chosen city
 * and interests are. Keeping them here avoids a parallel migration against the
 * schema owner's model.
 *
 * Never put a secret, token or anything sensitive in here: the seller fields are
 * served publicly, and the whole column is written by the profile routes.
 *
 * Trade-off worth knowing: JSON is not indexed, so filtering events by a
 * seller's city at scale (XRPL-059, XRPL-089) would want a real column. At the
 * sizes this demo runs at, reading and filtering in the application is fine.
 */

export const ProfileSettings = z.object({
  bio: z.string().max(1_000).default(""),
  city: z.string().max(80).nullable().default(null),
  websiteUrl: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  socialLinks: z.array(SocialLink).max(6).default([]),
  interests: StoredInterests.default([]),
  visibility: ProfileVisibility.default("PUBLIC"),
});
export type ProfileSettings = z.infer<typeof ProfileSettings>;

export const EMPTY_PROFILE_SETTINGS: ProfileSettings = {
  bio: "",
  city: null,
  websiteUrl: null,
  imageUrl: null,
  socialLinks: [],
  interests: [],
  visibility: "PUBLIC",
};

/**
 * Reads the profile portion of a user's settings.
 *
 * Unparseable or partial stored data falls back to defaults rather than
 * throwing: a profile written by an older version of the app, or by hand, must
 * not break the page that renders it.
 */
export function readProfileSettings(settings: unknown): ProfileSettings {
  if (!settings || typeof settings !== "object") return { ...EMPTY_PROFILE_SETTINGS };
  const parsed = ProfileSettings.safeParse(settings);
  if (parsed.success) return parsed.data;

  // Salvage whatever individual fields are valid.
  const source = settings as Record<string, unknown>;
  const field = <T>(key: keyof ProfileSettings, schema: z.ZodType<T>, fallback: T): T => {
    const result = schema.safeParse(source[key]);
    return result.success ? result.data : fallback;
  };
  return {
    bio: field("bio", z.string().max(1_000), ""),
    city: field("city", z.string().max(80).nullable(), null),
    websiteUrl: field("websiteUrl", z.string().nullable(), null),
    imageUrl: field("imageUrl", z.string().nullable(), null),
    socialLinks: field("socialLinks", z.array(SocialLink).max(6), []),
    interests: field("interests", StoredInterests, []),
    visibility: field("visibility", ProfileVisibility, "PUBLIC"),
  };
}

/**
 * Merges a patch into stored settings, preserving unrelated keys.
 *
 * Other features also keep preferences in this column, so the whole object is
 * spread back rather than replaced. An empty string for a URL clears it, which
 * is how the forms express "remove this".
 */
export function mergeProfileSettings(
  existing: unknown,
  patch: Partial<Record<keyof ProfileSettings, unknown>>,
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const current = readProfileSettings(existing);
  const next: ProfileSettings = { ...current };

  if (patch.bio !== undefined) next.bio = String(patch.bio);
  if (patch.city !== undefined) {
    const city = String(patch.city).trim();
    next.city = city === "" ? null : city;
  }
  if (patch.websiteUrl !== undefined) {
    const url = String(patch.websiteUrl).trim();
    next.websiteUrl = url === "" ? null : url;
  }
  if (patch.imageUrl !== undefined) {
    const url = String(patch.imageUrl).trim();
    next.imageUrl = url === "" ? null : url;
  }
  if (patch.socialLinks !== undefined) {
    next.socialLinks = SocialLink.array().max(6).parse(patch.socialLinks);
  }
  if (patch.interests !== undefined) {
    next.interests = z
      .array(EventCategory)
      .max(EVENT_CATEGORIES.length)
      .parse(patch.interests);
  }
  if (patch.visibility !== undefined) {
    next.visibility = ProfileVisibility.parse(patch.visibility);
  }

  return { ...base, ...next };
}
