import { TicketTierInput } from "@/contracts";
import { requireEventOwner } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { addTier } from "@/features/events/event-store";
import { toTierHttpError } from "@/features/events/tier-errors";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/events/:id/tiers — add a priced ticket tier (XRPL-016).
 *
 * 401 without a session, 404 for an unknown event, 403 unless the session owns
 * it, 409 when the event already has a tier with the same name.
 */
export const POST = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id } = await ctx.params;
  // Ownership is settled before the body is read, so an unauthorised caller
  // learns nothing about whether their input would have been valid.
  await requireEventOwner(db, session, id);

  const input = await parseJsonBody(req, TicketTierInput);
  try {
    const event = await addTier(db, id, input);
    return jsonOk(event, { status: 201, requestId });
  } catch (error) {
    throw toTierHttpError(error);
  }
});
