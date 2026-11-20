import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import { getResalePolicy } from "@/lib/resale-policy/server";
import { resolveVisibleEventId } from "@/lib/resale-policy/route-helpers";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/events/:id/resale-offers: public resale listings, only when the event is eligible (XRPL-037).
 * 200 { data: { eligibility, offers: ResaleListing[], limitationNotice, priceCapNotice } }.
 * Offers are empty until primary sells out. Listings come from validated offers in the app; buyers'
 * accept flow re-checks the live offer on XRPL. Never cached.
 */
export const GET = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const eventId = await resolveVisibleEventId(req, (await ctx.params).id);
  const policy = getResalePolicy();
  const { eligibility, offers } = await policy.listPublicOffers(eventId);
  return jsonOk(
    { eligibility, offers, limitationNotice: RESALE_LIMITATION_NOTICE, priceCapNotice: policy.priceCapNotice() },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
});
