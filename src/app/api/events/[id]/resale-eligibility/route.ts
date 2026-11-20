import { getResalePolicy } from "@/lib/resale-policy/server";
import { resolveVisibleEventId } from "@/lib/resale-policy/route-helpers";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/events/:id/resale-eligibility: may this app list resale tickets for the event? (XRPL-037)
 * 200 { data: ResaleEligibility & { priceCapNotice } }. The rule is app-only; `message` says so.
 * Public for published events; drafts only for their owner (404 otherwise). Never cached.
 */
export const GET = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const eventId = await resolveVisibleEventId(req, (await ctx.params).id);
  const policy = getResalePolicy();
  const eligibility = await policy.getEligibility(eventId);
  return jsonOk(
    { ...eligibility, priceCapNotice: policy.priceCapNotice() },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
});
