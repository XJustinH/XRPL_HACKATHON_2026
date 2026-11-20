import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  EVENT_MANAGER_ROLES,
  type EventView,
  type SellerProfile,
  type SellerProfilePatch,
} from "@/contracts";
import { toEventView } from "@/features/events/event-store";
import { mergeProfileSettings, readProfileSettings } from "./profile-settings";

/**
 * Seller profile and storefront reads and writes (XRPL-055).
 *
 * Profile fields live in `User.settings`; see `./profile-settings` for why.
 */

type ProfileDb = Pick<PrismaClient, "user" | "event">;

/** Raised when a profile cannot be served, rather than returning a hollow one. */
export class ProfileNotFoundError extends Error {
  constructor(message = "Seller not found") {
    super(message);
    this.name = "ProfileNotFoundError";
  }
}

function isEventManagerRole(role: string): boolean {
  return (EVENT_MANAGER_ROLES as readonly string[]).includes(role);
}

/**
 * A seller's public profile.
 *
 * Only accounts that can actually run events have a seller profile, so a
 * customer's id returns not-found rather than an empty storefront.
 */
export async function getSellerProfile(
  db: ProfileDb,
  sellerId: string,
): Promise<SellerProfile> {
  const user = await db.user.findUnique({
    where: { id: sellerId },
    select: { id: true, role: true, displayName: true, settings: true, createdAt: true },
  });
  if (!user || !isEventManagerRole(user.role)) throw new ProfileNotFoundError();

  const settings = readProfileSettings(user.settings);
  const publishedEventCount = await db.event.count({
    where: { sellerId, status: "PUBLISHED" },
  });

  return {
    id: user.id,
    displayName: user.displayName,
    bio: settings.bio,
    city: settings.city,
    websiteUrl: settings.websiteUrl,
    imageUrl: settings.imageUrl,
    socialLinks: settings.socialLinks,
    // No verification process exists yet; see the contract's note.
    isVerified: false,
    // Null rather than 0 until follows exist (XRPL-061).
    followerCount: null,
    publishedEventCount,
    joinedAt: user.createdAt.toISOString(),
  };
}

/**
 * Updates the signed-in seller's own profile.
 *
 * Takes the user id from the caller's session, never from input, so this cannot
 * be pointed at another account. `displayName` lives on the User row; the rest
 * are merged into settings without disturbing other features' preferences.
 */
export async function updateSellerProfile(
  db: ProfileDb,
  sellerId: string,
  patch: SellerProfilePatch,
): Promise<SellerProfile> {
  const user = await db.user.findUnique({
    where: { id: sellerId },
    select: { id: true, role: true, settings: true },
  });
  if (!user || !isEventManagerRole(user.role)) throw new ProfileNotFoundError();

  const settings = mergeProfileSettings(user.settings, {
    ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
    ...(patch.city !== undefined ? { city: patch.city } : {}),
    ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
    ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
    ...(patch.socialLinks !== undefined ? { socialLinks: patch.socialLinks } : {}),
  });

  await db.user.update({
    where: { id: sellerId },
    data: {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      // The merged object is plain JSON by construction; Prisma wants its own
      // JSON input type rather than a loose record.
      settings: settings as Prisma.InputJsonObject,
    },
  });

  return getSellerProfile(db, sellerId);
}

/**
 * A seller's published, upcoming events for their storefront.
 *
 * Reuses the public listing's rules so a storefront can never show a draft that
 * the homepage would hide.
 */
export async function listSellerStorefrontEvents(
  db: Pick<PrismaClient, "event">,
  sellerId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<EventView[]> {
  const rows = await db.event.findMany({
    where: {
      sellerId,
      status: "PUBLISHED",
      startsAt: { gt: options.now ?? new Date() },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 24,
    include: {
      seller: { select: { id: true, displayName: true, role: true } },
      tiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });
  return rows.map(toEventView);
}
