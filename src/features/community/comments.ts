import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { COMMENTS_PER_MINUTE, type CommentInput, type CommentView } from "@/contracts/community";
import { errors } from "@/lib/http/response";
import { isModerator, rateLimited } from "./access";
import { requireVisiblePost } from "./posts";

/**
 * Comments on seller posts (XRPL-082).
 *
 * A comment always belongs to a post, so there is no way for a customer to create a top-level
 * post through here. Authors delete their own comments; the seller who owns the post can hide or
 * remove any comment on it; site moderators can hide. Text arrives cleaned by `CommentInput` and
 * is stored as plain text, which React escapes when it renders.
 */

type Db = PrismaClient;

const MINUTE_MS = 60 * 1000;
const COMMENTS_PER_POST = 100;

const select = {
  id: true,
  postId: true,
  authorId: true,
  body: true,
  hiddenAt: true,
  hiddenById: true,
  createdAt: true,
  author: { select: { displayName: true } },
  post: { select: { sellerId: true } },
} satisfies Prisma.PostCommentSelect;

type Row = Prisma.PostCommentGetPayload<{ select: typeof select }>;

function toView(row: Row, viewerId: string | null): CommentView {
  const ownsPost = viewerId !== null && row.post.sellerId === viewerId;
  return {
    id: row.id,
    postId: row.postId,
    author: { id: row.authorId, displayName: row.author.displayName },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    hidden: row.hiddenAt !== null,
    canDelete: viewerId !== null && (row.authorId === viewerId || ownsPost),
    canHide: ownsPost || isModerator(viewerId),
  };
}

/**
 * Adds a comment. At most COMMENTS_PER_MINUTE per account in any minute, counted in the database
 * across all posts, so opening more tabs or posts does not raise the limit.
 */
export async function addComment(
  db: Db,
  userId: string,
  postId: string,
  input: CommentInput,
  now = new Date(),
): Promise<CommentView> {
  await requireVisiblePost(db, postId);

  const recent = await db.postComment.count({
    where: { authorId: userId, createdAt: { gt: new Date(now.getTime() - MINUTE_MS) } },
  });
  if (recent >= COMMENTS_PER_MINUTE) {
    throw rateLimited(`You're commenting too quickly. You can post ${COMMENTS_PER_MINUTE} comments a minute.`);
  }

  const row = await db.postComment.create({
    data: { postId, authorId: userId, body: input.body, createdAt: now },
    select,
  });
  return toView(row, userId);
}

/**
 * Comments on several posts at once, oldest first, keyed by post id. Hidden comments are only
 * returned to the seller who owns the post and to moderators.
 */
export async function listCommentsForPosts(
  db: Db,
  postIds: string[],
  viewerId: string | null,
): Promise<Map<string, CommentView[]>> {
  const byPost = new Map<string, CommentView[]>(postIds.map((id) => [id, []]));
  if (postIds.length === 0) return byPost;

  const moderator = isModerator(viewerId);
  const rows = await db.postComment.findMany({
    where: {
      postId: { in: postIds },
      ...(moderator
        ? {}
        : { OR: [{ hiddenAt: null }, ...(viewerId ? [{ post: { sellerId: viewerId } }] : [])] }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: COMMENTS_PER_POST * postIds.length,
    select,
  });
  for (const row of rows) {
    const list = byPost.get(row.postId);
    if (list && list.length < COMMENTS_PER_POST) list.push(toView(row, viewerId));
  }
  return byPost;
}

/** Comments on one post. 404 when the post is missing, or hidden from this viewer. */
export async function listComments(db: Db, postId: string, viewerId: string | null): Promise<CommentView[]> {
  const post = await db.sellerPost.findUnique({ where: { id: postId }, select: { sellerId: true, hiddenAt: true } });
  const canSeeHidden = viewerId !== null && (post?.sellerId === viewerId || isModerator(viewerId));
  if (!post || (post.hiddenAt && !canSeeHidden)) throw errors.notFound("Post not found");
  return (await listCommentsForPosts(db, [postId], viewerId)).get(postId) ?? [];
}

async function findComment(db: Db, commentId: string): Promise<Row> {
  const row = await db.postComment.findUnique({ where: { id: commentId }, select });
  if (!row) throw errors.notFound("Comment not found");
  return row;
}

/** Removes a comment: its author, or the seller who owns the post it is on. */
export async function deleteComment(db: Db, userId: string, commentId: string): Promise<void> {
  const row = await findComment(db, commentId);
  if (row.authorId !== userId && row.post.sellerId !== userId) {
    throw errors.forbidden("You can only delete your own comments.");
  }
  await db.postComment.delete({ where: { id: commentId } });
}

/**
 * Hides a comment, or shows it again: the seller who owns the post, or a moderator. The row is
 * kept, with who hid it and why. A seller cannot undo a moderator's decision.
 */
export async function setCommentHidden(
  db: Db,
  actorId: string,
  commentId: string,
  hidden: boolean,
  reason?: string,
  now = new Date(),
): Promise<CommentView> {
  const row = await findComment(db, commentId);
  const moderator = isModerator(actorId);
  if (!moderator && row.post.sellerId !== actorId) {
    throw errors.forbidden("Only the seller who owns this post can moderate its comments.");
  }
  if (!hidden && !moderator && row.hiddenById !== null && row.hiddenById !== actorId) {
    throw errors.forbidden("This comment was hidden by a moderator.");
  }
  if (hidden && row.hiddenAt) return toView(row, actorId); // already hidden: keep who and why
  const updated = await db.postComment.update({
    where: { id: commentId },
    data: hidden
      ? { hiddenAt: now, hiddenById: actorId, hiddenReason: reason || null }
      : { hiddenAt: null, hiddenById: null, hiddenReason: null },
    select,
  });
  return toView(updated, actorId);
}
