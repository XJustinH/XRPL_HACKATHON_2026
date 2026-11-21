import { likePost, unlikePost } from "@/features/community/likes";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/posts/:id/likes: like a post (XRPL-081). Idempotent: an account's second like changes
 * nothing. Returns the count as the database now has it.
 */
export const POST = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await likePost(db, session.userId, await idParam(ctx, "Post not found")), { requestId });
});

/** DELETE /api/posts/:id/likes: remove your like. Also idempotent. */
export const DELETE = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await unlikePost(db, session.userId, await idParam(ctx, "Post not found")), { requestId });
});
