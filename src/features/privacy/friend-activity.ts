import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getFriendService } from "@/features/friends/server";
import { listAttendedEvents } from "@/features/checkin/attendance-history";
import { listWishlistEventIds } from "@/features/profiles/wishlist";
import {
  canViewActivity,
  mergeVisibilitySettings,
  readVisibilitySettings,
  type ActivityKind,
  type ActivityVisibility,
  type VisibilitySettings,
} from "./visibility";

/**
 * Which of a viewer's friends are going to, or interested in, one event
 * (XRPL-085, XRPL-086).
 *
 * Both answers are assembled friend-by-friend, and each friend is included only
 * if **their own** settings permit it for **that** event. A friend who shares
 * nothing is absent, and the count never includes anyone hidden — so a count
 * cannot be used to infer a hidden friend's activity.
 *
 * Blocked users are excluded before anything is read.
 */

type Db = Pick<PrismaClient, "user" | "walletLink" | "checkInRecord">;

export type FriendOnEvent = { userId: string; displayName: string };

export type FriendActivity = {
  /** Friends who were admitted at the door and share their attendance. */
  attending: FriendOnEvent[];
  /** Friends who saved the event and share their saved events. */
  interested: FriendOnEvent[];
};

const EMPTY: FriendActivity = { attending: [], interested: [] };

/**
 * Accepted friends of `userId`.
 *
 * `listFriendIds` is the friend service's own accessor (XRPL-084) and already
 * returns only accepted, non-blocked connections, so blocking is handled before
 * any activity is read rather than filtered afterwards.
 */
async function acceptedFriendIds(userId: string): Promise<string[]> {
  return getFriendService().listFriendIds(userId);
}

/**
 * Friends attending and interested in one event.
 *
 * Returns empty rather than throwing if the friend service is unavailable:
 * this is a decorative panel, and a privacy-sensitive one, so the safe failure
 * is to show nothing.
 */
export async function getFriendActivityForEvent(
  db: Db,
  input: { viewerId: string | null; eventId: string },
): Promise<FriendActivity> {
  if (!input.viewerId) return EMPTY;

  let friendIds: string[];
  try {
    friendIds = await acceptedFriendIds(input.viewerId);
  } catch (error) {
    console.error("[privacy] friend list unavailable", error);
    return EMPTY;
  }
  if (friendIds.length === 0) return EMPTY;

  const friends = await db.user.findMany({
    where: { id: { in: friendIds } },
    select: { id: true, displayName: true, settings: true },
  });

  const attending: FriendOnEvent[] = [];
  const interested: FriendOnEvent[] = [];

  for (const friend of friends) {
    const settings = readVisibilitySettings(friend.settings);
    const entry = { userId: friend.id, displayName: friend.displayName };

    // Each kind is permitted separately: sharing attendance does not share
    // saved events.
    const mayShowAttendance = canViewActivity({
      ownerSettings: settings,
      kind: "attendance",
      eventId: input.eventId,
      viewerIsOwner: false,
      areFriends: true,
    });
    const mayShowWishlist = canViewActivity({
      ownerSettings: settings,
      kind: "wishlist",
      eventId: input.eventId,
      viewerIsOwner: false,
      areFriends: true,
    });

    // Nothing is read for a friend who shares nothing, so a hidden friend's
    // activity is never even loaded.
    if (mayShowAttendance) {
      const attended = await listAttendedEvents(db, friend.id, Number.MAX_SAFE_INTEGER);
      if (attended.some((event) => event.eventId === input.eventId)) attending.push(entry);
    }
    if (mayShowWishlist) {
      const saved = await listWishlistEventIds(db, friend.id);
      if (saved.includes(input.eventId)) interested.push(entry);
    }
  }

  const byName = (a: FriendOnEvent, b: FriendOnEvent) =>
    a.displayName.localeCompare(b.displayName);
  return { attending: attending.sort(byName), interested: interested.sort(byName) };
}

/* ------------------------------------------------------------------ *
 * Settings writes (XRPL-088)
 * ------------------------------------------------------------------ */

export async function getVisibilitySettings(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<VisibilitySettings> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return readVisibilitySettings(user?.settings);
}

/** Updates a user's own visibility. The account is always the caller's own. */
export async function updateVisibilitySettings(
  db: Pick<PrismaClient, "user">,
  userId: string,
  patch: {
    attendanceVisibility?: ActivityVisibility;
    wishlistVisibility?: ActivityVisibility;
    event?: { eventId: string; kind: ActivityKind; value: ActivityVisibility | null };
  },
): Promise<VisibilitySettings> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  const settings = mergeVisibilitySettings(user?.settings, patch);
  await db.user.update({
    where: { id: userId },
    data: { settings: settings as Prisma.InputJsonObject },
  });
  return readVisibilitySettings(settings);
}
