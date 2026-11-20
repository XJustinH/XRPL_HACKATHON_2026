import { TicketTierPatch } from "@/contracts";
import { requireEventOwner } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { removeTier, updateTier } from "@/features/events/event-store";
import { toTierHttpError } from "@/features/events/tier-errors";

type Ctx = { params: Promise<{ id: string; tierId: string }> };

/**
 * PATCH /api/events/:id/tiers/:tierId — edit a tier (XRPL-016).
 *
 * 409 when the tier's price is fixed by an existing mint, when the new quantity
 * is below what has already been minted, or when the name collides.
 */
export const PATCH = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id, tierId } = await ctx.params;
  await requireEventOwner(db, session, id);

  const input = await parseJsonBody(req, TicketTierPatch);
  try {
    const event = await updateTier(db, id, tierId, input);
    return jsonOk(event, { requestId });
  } catch (error) {
    throw toTierHttpError(error);
  }
});

/**
 * DELETE /api/events/:id/tiers/:tierId — remove a tier (XRPL-016).
 *
 * 409 once any ticket row exists for the tier, including tickets still pending
 * a mint.
 */
export const DELETE = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id, tierId } = await ctx.params;
  await requireEventOwner(db, session, id);

  try {
    const event = await removeTier(db, id, tierId);
    return jsonOk(event, { requestId });
  } catch (error) {
    throw toTierHttpError(error);
  }
});
