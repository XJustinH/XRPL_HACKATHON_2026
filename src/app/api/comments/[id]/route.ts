import { deleteComment } from "@/features/community/comments";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * DELETE /api/comments/:id: remove a comment (XRPL-082). Allowed for its author and for the
 * seller who owns the post it is on; 403 for anyone else.
 */
export const DELETE = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const commentId = await idParam(ctx, "Comment not found");
  await deleteComment(db, session.userId, commentId);
  return jsonOk({ id: commentId, deleted: true }, { requestId });
});
