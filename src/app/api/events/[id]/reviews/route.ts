import { ReviewInput } from "@/contracts/reviews";
import { getReviewService } from "@/features/reviews/server";
import { getRequestSession, requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { resolveVisibleEventId } from "@/lib/resale-policy/route-helpers";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/events/:id/reviews: visible reviews, newest first, with count, average and whether the
 * viewer may review (XRPL-079). Public for published events; drafts only for their owner.
 */
export const GET = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const eventId = await resolveVisibleEventId(req, (await ctx.params).id);
  const session = await getRequestSession(req);
  const data = await getReviewService().list(eventId, session?.userId ?? null);
  return jsonOk(data, { requestId, headers: { "Cache-Control": "no-store" } });
});

/**
 * POST /api/events/:id/reviews: { rating 1-5, body? } -> 201 review.
 * 403 NOT_ATTENDED unless one of the customer's verified wallets was checked in at this event;
 * 409 ALREADY_REVIEWED if they already posted (use PATCH .../reviews/mine).
 */
export const POST = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const eventId = await resolveVisibleEventId(req, (await ctx.params).id);
  const input = await parseJsonBody(req, ReviewInput);
  const review = await getReviewService().create(session.userId, eventId, input);
  return jsonOk(review, { status: 201, requestId });
});
