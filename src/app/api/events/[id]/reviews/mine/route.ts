import { ReviewInput } from "@/contracts/reviews";
import { getReviewService } from "@/features/reviews/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { resolveVisibleEventId } from "@/lib/resale-policy/route-helpers";

/** PATCH /api/events/:id/reviews/mine: edit your own review (XRPL-079). 404 if you have none. */
export const PATCH = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const eventId = await resolveVisibleEventId(req, (await ctx.params).id);
  const input = await parseJsonBody(req, ReviewInput);
  return jsonOk(await getReviewService().updateOwn(session.userId, eventId, input), { requestId });
});
