import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AppId } from "@/contracts/common";
import type { NotificationInbox, NotificationView } from "@/contracts/community";
import { listFollowedSellerIds } from "@/features/profiles/follows";
import { errors } from "@/lib/http/response";
import { excerpt } from "./access";

/**
 * Notifications about followed sellers (XRPL-093).
 *
 * Generated lazily, when the inbox is read, rather than when a seller publishes: for every seller
 * the user follows, one notification per event published (and per post written) since the follow
 * was made. The table has a unique index per user and event, and per user and post, and rows are
 * inserted with ON CONFLICT DO NOTHING, so reading the inbox again, or from two tabs at once,
 * cannot duplicate a notification or reset one that was read.
 *
 * These are optional notifications. A user who opts out gets no new ones; what was already in the
 * inbox stays. Opting back in starts from that moment, so nothing published in between appears.
 */

type Db = PrismaClient;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Follows are still stored as a list in `User.settings` (see profiles/follows.ts), which has no
 * date. When a followed seller has no dated `Follow` row, events from this many days back count
 * as "since the follow".
 */
export const UNDATED_FOLLOW_LOOKBACK_DAYS = 30;
const GENERATE_LIMIT = 200;
const INBOX_LIMIT = 50;

type NotificationPrefs = { optOut: boolean; resumedAt: Date | null };

/** The `notifications` key of `User.settings`. Anything unreadable means the defaults (opted in). */
export function readNotificationPrefs(settings: unknown): NotificationPrefs {
  const raw =
    settings && typeof settings === "object" ? (settings as { notifications?: unknown }).notifications : null;
  const prefs = raw && typeof raw === "object" ? (raw as { optOut?: unknown; resumedAt?: unknown }) : {};
  const resumedAt = typeof prefs.resumedAt === "string" ? new Date(prefs.resumedAt) : null;
  return {
    optOut: prefs.optOut === true,
    resumedAt: resumedAt && !Number.isNaN(resumedAt.getTime()) ? resumedAt : null,
  };
}

/**
 * Turns optional notifications off or on. Stored in `User.settings` beside the other preferences;
 * the rest of the object is spread back so they survive.
 */
export async function setNotificationOptOut(
  db: Db,
  userId: string,
  optOut: boolean,
  now = new Date(),
): Promise<{ optedOut: boolean }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) throw errors.notFound("Account not found");
  const base =
    user.settings && typeof user.settings === "object" && !Array.isArray(user.settings)
      ? (user.settings as Record<string, unknown>)
      : {};
  const current = readNotificationPrefs(base);
  const resumedAt = !optOut && current.optOut ? now : current.resumedAt;
  const settings = {
    ...base,
    notifications: { optOut, resumedAt: resumedAt ? resumedAt.toISOString() : null },
  };
  await db.user.update({ where: { id: userId }, data: { settings: settings as Prisma.InputJsonObject } });
  return { optedOut: optOut };
}

/**
 * Creates any missing notifications for this user and returns how many were new.
 * Does nothing for a user who has opted out.
 */
export async function generateNotifications(db: Db, userId: string, now = new Date()): Promise<number> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { settings: true } });
  if (!user) return 0;
  const prefs = readNotificationPrefs(user.settings);
  if (prefs.optOut) return 0;

  // The follows service is the source of truth for who is followed; ids that are not well-formed
  // are dropped before they reach a uuid column.
  const sellerIds = (await listFollowedSellerIds(db, userId)).filter((id) => AppId.safeParse(id).success);
  if (sellerIds.length === 0) return 0;

  const dated = await db.follow.findMany({
    where: { followerId: userId, sellerId: { in: sellerIds } },
    select: { sellerId: true, createdAt: true },
  });
  const followedAt = new Map(dated.map((follow) => [follow.sellerId, follow.createdAt]));
  const fallback = new Date(now.getTime() - UNDATED_FOLLOW_LOOKBACK_DAYS * DAY_MS);
  const since = (sellerId: string): Date => {
    const followed = followedAt.get(sellerId) ?? fallback;
    return prefs.resumedAt && prefs.resumedAt > followed ? prefs.resumedAt : followed;
  };

  const [events, posts] = await Promise.all([
    // Only events that are public and still to come: the same rule as the follow feed.
    db.event.findMany({
      where: {
        status: "PUBLISHED",
        startsAt: { gt: now },
        OR: sellerIds.map((sellerId) => ({
          sellerId,
          OR: [
            { publishedAt: { gte: since(sellerId) } },
            { publishedAt: null, createdAt: { gte: since(sellerId) } },
          ],
        })),
      },
      orderBy: { createdAt: "desc" },
      take: GENERATE_LIMIT,
      select: { id: true, publishedAt: true, createdAt: true },
    }),
    db.sellerPost.findMany({
      where: {
        hiddenAt: null,
        OR: sellerIds.map((sellerId) => ({ sellerId, createdAt: { gte: since(sellerId) } })),
      },
      orderBy: { createdAt: "desc" },
      take: GENERATE_LIMIT,
      select: { id: true, createdAt: true },
    }),
  ]);
  if (events.length + posts.length === 0) return 0;

  const created = await db.notification.createMany({
    data: [
      // Dated when the thing happened, not when the inbox was opened, so the inbox sorts sensibly.
      ...events.map((event) => ({
        userId,
        kind: "NEW_EVENT" as const,
        eventId: event.id,
        createdAt: event.publishedAt ?? event.createdAt,
      })),
      ...posts.map((post) => ({ userId, kind: "NEW_POST" as const, postId: post.id, createdAt: post.createdAt })),
    ],
    skipDuplicates: true,
  });
  return created.count;
}

/** Notifications whose subject can still be shown: a published event or a post that is not hidden. */
const visibleTo = (userId: string) =>
  ({
    userId,
    OR: [{ event: { is: { status: "PUBLISHED" } } }, { post: { is: { hiddenAt: null } } }],
  }) satisfies Prisma.NotificationWhereInput;

const seller = { select: { id: true, displayName: true } };
const select = {
  id: true,
  kind: true,
  readAt: true,
  createdAt: true,
  event: { select: { id: true, title: true, seller } },
  post: { select: { id: true, body: true, seller } },
} satisfies Prisma.NotificationSelect;

function toView(row: Prisma.NotificationGetPayload<{ select: typeof select }>): NotificationView | null {
  const subject = row.event
    ? { seller: row.event.seller, title: row.event.title, href: `/events/${row.event.id}` }
    : row.post
      ? { seller: row.post.seller, title: excerpt(row.post.body, 100), href: `/sellers/${row.post.seller.id}` }
      : null;
  if (!subject) return null;
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    ...subject,
  };
}

/** The user's inbox, newest first. Generates anything missing first. */
export async function getInbox(db: Db, userId: string, now = new Date()): Promise<NotificationInbox> {
  await generateNotifications(db, userId, now);
  const [rows, unreadCount, user] = await Promise.all([
    db.notification.findMany({
      where: visibleTo(userId),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: INBOX_LIMIT,
      select,
    }),
    db.notification.count({ where: { ...visibleTo(userId), readAt: null } }),
    db.user.findUnique({ where: { id: userId }, select: { settings: true } }),
  ]);
  return {
    items: rows.map(toView).filter((item): item is NotificationView => item !== null),
    unreadCount,
    optedOut: readNotificationPrefs(user?.settings).optOut,
  };
}

/** Unread count for a badge. Generates anything missing first, like the inbox. */
export async function countUnreadNotifications(db: Db, userId: string, now = new Date()): Promise<number> {
  await generateNotifications(db, userId, now);
  return db.notification.count({ where: { ...visibleTo(userId), readAt: null } });
}

/** Marks one of the user's own notifications read. 404 for anyone else's. Idempotent. */
export async function markNotificationRead(db: Db, userId: string, id: string, now = new Date()): Promise<void> {
  const own = await db.notification.findFirst({ where: { id, userId }, select: { id: true } });
  if (!own) throw errors.notFound("Notification not found");
  await db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } });
}

/** Marks every unread notification read and returns how many changed. */
export async function markAllNotificationsRead(db: Db, userId: string, now = new Date()): Promise<number> {
  const updated = await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: now } });
  return updated.count;
}
