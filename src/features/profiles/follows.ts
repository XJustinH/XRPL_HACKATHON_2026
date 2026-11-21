import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { EVENT_MANAGER_ROLES, type EventView, type SellerSummary } from "@/contracts";
import { toEventView } from "@/features/events/event-store";
import { readProfileSettings } from "./profile-settings";

/**
 * Following sellers (XRPL-061).
 *
 * Stored as a list of seller ids in `User.settings`, the same column the rest
 * of the profile preferences use. There is no `Follow` table yet, and adding a
 * parallel migration against the schema owner's model is not this issue's job.
 *
 * Consequence worth knowing: the list is per-follower, so "who follows this
 * seller" cannot be answered without scanning every user. `SellerProfile`
 * therefore still reports `followerCount: null` rather than a wrong number.
 * A `Follow` table with both directions indexed would fix that and is also what
 * XRPL-086 needs for shared wishlists.
 */

type FollowDb = Pick<PrismaClient, "user" | "event">;

/** A followed account, resolved for display. */
export type FollowedSeller = SellerSummary & {
  /** Upcoming published events this seller has, for the follow feed. */
  upcomingEventCount: number;
};

const MAX_FOLLOWS = 200;

function readFollows(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as { follows?: unknown }).follows;
  if (!Array.isArray(raw)) return [];
  // De-duplicated on read as well as on write, so a hand-edited row cannot
  // produce a doubled entry in the UI.
  return [...new Set(raw.filter((id): id is string => typeof id === "string"))];
}

export async function listFollowedSellerIds(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return readFollows(user?.settings);
}

export async function isFollowing(
  db: Pick<PrismaClient, "user">,
  userId: string,
  sellerId: string,
): Promise<boolean> {
  return (await listFollowedSellerIds(db, userId)).includes(sellerId);
}

/** Raised when a follow cannot be applied, rather than silently doing nothing. */
export class FollowError extends Error {
  constructor(
    readonly code: "NOT_A_SELLER" | "CANNOT_FOLLOW_SELF" | "TOO_MANY_FOLLOWS",
    message: string,
  ) {
    super(message);
    this.name = "FollowError";
  }
}

async function writeFollows(
  db: Pick<PrismaClient, "user">,
  userId: string,
  next: string[],
): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const base =
    user?.settings && typeof user.settings === "object"
      ? (user.settings as Record<string, unknown>)
      : {};
  // Spread the existing object so other features' preferences survive.
  const settings = { ...base, ...readProfileSettings(user?.settings), follows: next };
  await db.user.update({
    where: { id: userId },
    data: { settings: settings as Prisma.InputJsonObject },
  });
  return next;
}

/**
 * Follows a seller. Following twice is a no-op rather than an error, so a
 * double-submitted form cannot create a duplicate.
 */
export async function followSeller(
  db: FollowDb,
  userId: string,
  sellerId: string,
): Promise<string[]> {
  if (userId === sellerId) {
    throw new FollowError("CANNOT_FOLLOW_SELF", "You cannot follow your own account");
  }

  const seller = await db.user.findUnique({
    where: { id: sellerId },
    select: { role: true },
  });
  if (!seller || !(EVENT_MANAGER_ROLES as readonly string[]).includes(seller.role)) {
    throw new FollowError("NOT_A_SELLER", "That account cannot be followed");
  }

  const current = await listFollowedSellerIds(db, userId);
  if (current.includes(sellerId)) return current;
  if (current.length >= MAX_FOLLOWS) {
    throw new FollowError(
      "TOO_MANY_FOLLOWS",
      `You can follow up to ${MAX_FOLLOWS} accounts`,
    );
  }
  return writeFollows(db, userId, [...current, sellerId]);
}

/** Unfollows a seller. Unfollowing something not followed is a no-op. */
export async function unfollowSeller(
  db: Pick<PrismaClient, "user">,
  userId: string,
  sellerId: string,
): Promise<string[]> {
  const current = await listFollowedSellerIds(db, userId);
  if (!current.includes(sellerId)) return current;
  return writeFollows(db, userId, current.filter((id) => id !== sellerId));
}

/**
 * The accounts a user follows, with their upcoming event counts.
 *
 * Ids that no longer resolve to a seller are dropped from the result rather
 * than shown as a broken row — the stored list is not cleaned up here, because
 * a read should not write.
 */
export async function listFollowedSellers(
  db: FollowDb,
  userId: string,
  now = new Date(),
): Promise<FollowedSeller[]> {
  const ids = await listFollowedSellerIds(db, userId);
  if (ids.length === 0) return [];

  const sellers = await db.user.findMany({
    where: { id: { in: ids }, role: { in: [...EVENT_MANAGER_ROLES] } },
    select: {
      id: true,
      displayName: true,
      settings: true,
      _count: {
        select: { events: { where: { status: "PUBLISHED", startsAt: { gt: now } } } },
      },
    },
    orderBy: { displayName: "asc" },
  });

  return sellers.map((seller) => ({
    id: seller.id,
    displayName: seller.displayName,
    city: readProfileSettings(seller.settings).city,
    isVerified: false,
    upcomingEventCount: seller._count.events,
  }));
}

/**
 * Upcoming published events from the accounts a user follows (XRPL-061).
 *
 * Reuses the public listing's filters, so a draft or finished event cannot
 * appear in a follow feed.
 */
export async function listEventsFromFollowedSellers(
  db: FollowDb,
  userId: string,
  options: { now?: Date; limit?: number } = {},
): Promise<EventView[]> {
  const ids = await listFollowedSellerIds(db, userId);
  if (ids.length === 0) return [];

  const rows = await db.event.findMany({
    where: {
      sellerId: { in: ids },
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
