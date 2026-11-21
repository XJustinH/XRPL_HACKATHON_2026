import type { PrismaClient } from "@/generated/prisma/client";
import type { LikeState } from "@/contracts/community";
import { errors } from "@/lib/http/response";
import { requireVisiblePost } from "./posts";

/**
 * Likes on seller posts (XRPL-081).
 *
 * One like per account per post is guaranteed by the table's primary key, so a double click or a
 * replayed request cannot count twice. The count returned is always read back from the database.
 */

type Db = PrismaClient;

const countLikes = (db: Db, postId: string) => db.postLike.count({ where: { postId } });

/** Likes a post. Liking twice is a no-op, not an error. */
export async function likePost(db: Db, userId: string, postId: string): Promise<LikeState> {
  await requireVisiblePost(db, postId);
  await db.postLike.createMany({ data: [{ postId, userId }], skipDuplicates: true });
  return { postId, liked: true, likeCount: await countLikes(db, postId) };
}

/** Removes a like. Unliking something not liked is a no-op. */
export async function unlikePost(db: Db, userId: string, postId: string): Promise<LikeState> {
  const post = await db.sellerPost.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw errors.notFound("Post not found");
  await db.postLike.deleteMany({ where: { postId, userId } });
  return { postId, liked: false, likeCount: await countLikes(db, postId) };
}
