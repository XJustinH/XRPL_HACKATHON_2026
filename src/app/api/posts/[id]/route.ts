import { SellerPostPatch } from "@/contracts/community";
import { deletePost, updatePost } from "@/features/community/posts";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/** PATCH /api/posts/:id: the seller edits their own post (XRPL-080). 403 for anyone else. */
export const PATCH = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const postId = await idParam(ctx, "Post not found");
  const patch = await parseJsonBody(req, SellerPostPatch);
  return jsonOk(await updatePost(db, session.userId, postId, patch), { requestId });
});

/** DELETE /api/posts/:id: the seller deletes their own post, with its likes and comments. */
export const DELETE = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const postId = await idParam(ctx, "Post not found");
  await deletePost(db, session.userId, postId);
  return jsonOk({ id: postId, deleted: true }, { requestId });
});
