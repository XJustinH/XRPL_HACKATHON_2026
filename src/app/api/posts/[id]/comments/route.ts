import { CommentInput, type PostCommentsData } from "@/contracts/community";
import { addComment, listComments } from "@/features/community/comments";
import { idParam, NO_STORE, type IdCtx } from "@/features/community/route-helpers";
import { getRequestSession, requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/posts/:id/comments: comments on a post, oldest first (XRPL-082). Public. Hidden
 * comments are returned only to the seller who owns the post and to moderators.
 */
export const GET = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const postId = await idParam(ctx, "Post not found");
  const session = await getRequestSession(req, db);
  const data: PostCommentsData = { postId, comments: await listComments(db, postId, session?.userId ?? null) };
  return jsonOk(data, { requestId, headers: NO_STORE });
});

/**
 * POST /api/posts/:id/comments: { body } -> 201 comment (XRPL-082).
 * 400 when the text breaks the content rules, 429 RATE_LIMITED past the per-minute limit.
 */
export const POST = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const postId = await idParam(ctx, "Post not found");
  const input = await parseJsonBody(req, CommentInput);
  return jsonOk(await addComment(db, session.userId, postId, input), { status: 201, requestId });
});
