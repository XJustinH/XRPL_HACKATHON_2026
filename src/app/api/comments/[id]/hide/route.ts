import { HideCommentInput } from "@/contracts/community";
import { setCommentHidden } from "@/features/community/comments";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/comments/:id/hide: { hidden?: boolean, reason? } (XRPL-082, XRPL-083).
 * Hides a comment from public view, or shows it again with `hidden: false`. Allowed for the seller
 * who owns the post and for moderators. The comment is kept, not deleted.
 */
export const POST = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const commentId = await idParam(ctx, "Comment not found");
  const input = await parseJsonBody(req, HideCommentInput);
  return jsonOk(await setCommentHidden(db, session.userId, commentId, input.hidden, input.reason), { requestId });
});
