import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AuthErrorCode, EVENT_MANAGER_ROLES } from "@/contracts";
import {
  POSTS_PER_HOUR,
  type SellerPostInput,
  type SellerPostPatch,
  type SellerPostView,
  type SellerPostsDashboard,
} from "@/contracts/community";
import { AppError, errors } from "@/lib/http/response";
import { isSellerRole, rateLimited } from "./access";

/**
 * Seller announcements (XRPL-080).
 *
 * Only seller and organiser accounts may publish. The role is read from the database for every
 * write, so a customer cannot post by calling the API directly, whatever the UI shows. Input is
 * already cleaned and validated by `SellerPostInput` (length, control characters, blocked words,
 * https image link).
 */

type Db = PrismaClient;

const HOUR_MS = 60 * 60 * 1000;
export const FEED_PAGE_SIZE = 20;

const select = {
  id: true,
  sellerId: true,
  body: true,
  imageUrl: true,
  hiddenAt: true,
  createdAt: true,
  updatedAt: true,
  seller: { select: { displayName: true } },
  // Counted by the database on every read; hidden comments are left out of the public number.
  _count: { select: { likes: true, comments: { where: { hiddenAt: null } } } },
} satisfies Prisma.SellerPostSelect;

type Row = Prisma.SellerPostGetPayload<{ select: typeof select }>;

/** Edits more than a second after posting count as edited. */
function toView(row: Row, likedByViewer: boolean): SellerPostView {
  const edited = row.updatedAt.getTime() - row.createdAt.getTime() > 1000;
  return {
    id: row.id,
    seller: { id: row.sellerId, displayName: row.seller.displayName },
    body: row.body,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt.toISOString(),
    editedAt: edited ? row.updatedAt.toISOString() : null,
    likeCount: row._count.likes,
    commentCount: row._count.comments,
    likedByViewer,
    hidden: row.hiddenAt !== null,
  };
}

async function requireSellerAccount(db: Db, userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user || !isSellerRole(user.role)) {
    throw new AppError(AuthErrorCode.ROLE_REQUIRED, "Only seller and organiser accounts can publish posts.", 403);
  }
}

async function requireOwnPost(db: Db, userId: string, postId: string): Promise<void> {
  const post = await db.sellerPost.findUnique({ where: { id: postId }, select: { sellerId: true } });
  if (!post) throw errors.notFound("Post not found");
  if (post.sellerId !== userId) throw errors.forbidden("Only the seller who wrote this post can change it.");
}

/** A post the public can see. Hidden and missing posts are the same 404. */
export async function requireVisiblePost(db: Db, postId: string): Promise<{ id: string; sellerId: string }> {
  const post = await db.sellerPost.findFirst({
    where: { id: postId, hiddenAt: null },
    select: { id: true, sellerId: true },
  });
  if (!post) throw errors.notFound("Post not found");
  return post;
}

export async function createPost(
  db: Db,
  userId: string,
  input: SellerPostInput,
  now = new Date(),
): Promise<SellerPostView> {
  await requireSellerAccount(db, userId);

  const recent = await db.sellerPost.count({
    where: { sellerId: userId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= POSTS_PER_HOUR) {
    throw rateLimited(`You can publish up to ${POSTS_PER_HOUR} posts an hour. Try again later.`);
  }

  const row = await db.sellerPost.create({
    data: { sellerId: userId, body: input.body, imageUrl: input.imageUrl ?? null },
    select,
  });
  return toView(row, false);
}

export async function updatePost(
  db: Db,
  userId: string,
  postId: string,
  patch: SellerPostPatch,
): Promise<SellerPostView> {
  await requireOwnPost(db, userId, postId);
  await requireSellerAccount(db, userId);
  const row = await db.sellerPost.update({
    where: { id: postId },
    data: {
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
    },
    select,
  });
  const liked = await db.postLike.count({ where: { postId, userId } });
  return toView(row, liked > 0);
}

/** Deletes the post with its likes, comments and notifications (database cascades). */
export async function deletePost(db: Db, userId: string, postId: string): Promise<void> {
  await requireOwnPost(db, userId, postId);
  await db.sellerPost.delete({ where: { id: postId } });
}

async function withViewerLikes(db: Db, rows: Row[], viewerId: string | null): Promise<SellerPostView[]> {
  const liked =
    viewerId && rows.length > 0
      ? await db.postLike.findMany({
          where: { userId: viewerId, postId: { in: rows.map((row) => row.id) } },
          select: { postId: true },
        })
      : [];
  const likedIds = new Set(liked.map((like) => like.postId));
  return rows.map((row) => toView(row, likedIds.has(row.id)));
}

/** A seller's public feed, newest first. Hidden posts are never included. */
export async function listSellerPosts(
  db: Db,
  sellerId: string,
  viewerId: string | null,
  limit = FEED_PAGE_SIZE,
): Promise<SellerPostView[]> {
  const rows = await db.sellerPost.findMany({
    where: { sellerId, hiddenAt: null, seller: { role: { in: [...EVENT_MANAGER_ROLES] } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select,
  });
  return withViewerLikes(db, rows, viewerId);
}

/**
 * The seller's own posts, including any hidden by moderation, with engagement totals across all
 * of them (XRPL-081).
 */
export async function getSellerPostsDashboard(db: Db, sellerId: string): Promise<SellerPostsDashboard> {
  const [rows, posts, likes, comments] = await Promise.all([
    db.sellerPost.findMany({
      where: { sellerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      select,
    }),
    db.sellerPost.count({ where: { sellerId } }),
    db.postLike.count({ where: { post: { sellerId } } }),
    db.postComment.count({ where: { post: { sellerId }, hiddenAt: null } }),
  ]);
  return { posts: await withViewerLikes(db, rows, sellerId), totals: { posts, likes, comments } };
}
