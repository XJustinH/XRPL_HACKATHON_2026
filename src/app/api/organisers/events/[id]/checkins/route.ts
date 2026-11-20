import { z } from "zod";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { getCheckInOverview } from "@/features/organiser/checkin-overview";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/organisers/events/:id/checkins: entry count and recent admissions (XRPL-048).
 * Organisers of this event only (interim rule: the event's seller, until XRPL-013).
 */
export const GET = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const eventId = z.uuid().parse((await ctx.params).id);
  const db = getDb();
  if (!(await new EventSellerAccess(db).canScanEvent(session.userId, eventId))) {
    throw errors.forbidden("You are not an organiser for this event");
  }
  const overview = await getCheckInOverview(db, eventId);
  return jsonOk(overview, { requestId, headers: { "Cache-Control": "no-store" } });
});
