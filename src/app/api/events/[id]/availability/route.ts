import { z } from "zod";
import { isEventOwner } from "@/lib/auth/permissions";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";

/**
 * GET /api/events/:id/availability — primary remaining and sell-out state (XRPL-020).
 * 200 { data: PrimaryAvailability } (src/contracts/inventory.ts). Public for published events.
 * A draft is visible only to its owner; everyone else gets 404, so drafts can't be discovered.
 * Live figures: never cached.
 */
export const GET = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const parsed = z.uuid().safeParse((await ctx.params).id);
  if (!parsed.success) throw errors.notFound("Event not found");
  const eventId = parsed.data;

  const db = getDb();
  const event = await db.event.findUnique({ where: { id: eventId }, select: { status: true } });
  if (!event) throw errors.notFound("Event not found");
  if (event.status !== "PUBLISHED") {
    const session = await getRequestSession(req, db);
    if (!session || !(await isEventOwner(db, session.userId, eventId))) throw errors.notFound("Event not found");
  }

  const availability = await getPrimaryAvailability(db, eventId);
  return jsonOk(availability, { requestId, headers: { "Cache-Control": "no-store" } });
});
