import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { EventView } from "@/contracts";
import { toEventView } from "@/features/events/event-store";
import { readProfileSettings } from "./profile-settings";

/**
 * Saved events (XRPL-062).
 *
 * Stored as a list of event ids in `User.settings`, like follows. See
 * `./follows` for why, and for the `Wishlist` table that would be better.
 *
 * Deliberately independent of ticket ownership: saving an event is a statement
 * of interest, and buying a ticket neither adds nor clears it. The two are
 * never derived from one another, so a holder can still have the event saved
 * and someone who saved it never has to buy.
 */

type WishlistDb = Pick<PrismaClient, "user" | "event">;

const MAX_WISHLIST = 500;

function readWishlist(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as { wishlist?: unknown }).wishlist;
  if (!Array.isArray(raw)) return [];
  // De-duplicated on read as well as on write.
  return [...new Set(raw.filter((id): id is string => typeof id === "string"))];
}

export async function listWishlistEventIds(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return readWishlist(user?.settings);
}

export async function isWishlisted(
  db: Pick<PrismaClient, "user">,
  userId: string,
  eventId: string,
): Promise<boolean> {
  return (await listWishlistEventIds(db, userId)).includes(eventId);
}

export class WishlistError extends Error {
  constructor(readonly code: "EVENT_NOT_FOUND" | "TOO_MANY_SAVED", message: string) {
    super(message);
    this.name = "WishlistError";
  }
}

async function writeWishlist(
  db: Pick<PrismaClient, "user">,
  userId: string,
  next: string[],
): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const base =
    user?.settings && typeof user.settings === "object"
      ? (user.settings as Record<string, unknown>)
      : {};
  const settings = { ...base, ...readProfileSettings(user?.settings), wishlist: next };
  await db.user.update({
    where: { id: userId },
    data: { settings: settings as Prisma.InputJsonObject },
  });
  return next;
}

/**
 * Saves an event. Saving twice is a no-op, so repeated saves cannot duplicate.
 *
 * Only a published event can be saved: a draft is not public, so a saved id
 * must never be a way to learn that one exists.
 */
export async function addToWishlist(
  db: WishlistDb,
  userId: string,
  eventId: string,
): Promise<string[]> {
  const event = await db.event.findFirst({
    where: { id: eventId, status: "PUBLISHED" },
    select: { id: true },
  });
  if (!event) throw new WishlistError("EVENT_NOT_FOUND", "That event could not be found");

  const current = await listWishlistEventIds(db, userId);
  if (current.includes(eventId)) return current;
  if (current.length >= MAX_WISHLIST) {
    throw new WishlistError("TOO_MANY_SAVED", `You can save up to ${MAX_WISHLIST} events`);
  }
  return writeWishlist(db, userId, [...current, eventId]);
}

/** Removes an event. Removing one that is not saved is a no-op. */
export async function removeFromWishlist(
  db: Pick<PrismaClient, "user">,
  userId: string,
  eventId: string,
): Promise<string[]> {
  const current = await listWishlistEventIds(db, userId);
  if (!current.includes(eventId)) return current;
  return writeWishlist(db, userId, current.filter((id) => id !== eventId));
}

export type WishlistEntries = {
  /** Saved events still on sale, soonest first. */
  upcoming: EventView[];
  /** Saved events that have already started, kept so the list is not a lie. */
  past: EventView[];
};

/**
 * The saved events a user can still see.
 *
 * An event that was unpublished since it was saved is omitted rather than
 * shown, because it is no longer public. Past events are kept but separated:
 * silently dropping them would look like the save had been lost.
 */
export async function listWishlistEvents(
  db: WishlistDb,
  userId: string,
  now = new Date(),
): Promise<WishlistEntries> {
  const ids = await listWishlistEventIds(db, userId);
  if (ids.length === 0) return { upcoming: [], past: [] };

  const rows = await db.event.findMany({
    where: { id: { in: ids }, status: "PUBLISHED" },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    include: {
      seller: { select: { id: true, displayName: true, role: true } },
      tiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
  });

  const events = rows.map(toEventView);
  return {
    upcoming: events.filter((event) => new Date(event.startsAt).getTime() > now.getTime()),
    past: events.filter((event) => new Date(event.startsAt).getTime() <= now.getTime()),
  };
}
