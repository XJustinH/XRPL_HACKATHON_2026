import { requireEventOwner } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { unpublishEvent } from "@/features/events/event-store";
import { toEventHttpError } from "@/features/events/tier-errors";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/events/:id/unpublish — return a published event to draft (XRPL-017).
 *
 * 409 HAS_MINTED_TICKETS once tickets exist on the ledger: buyers may already
 * hold them, and hiding the event would remove the public page their ticket
 * refers to.
 */
export const POST = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id } = await ctx.params;
  await requireEventOwner(db, session, id);

  try {
    const event = await unpublishEvent(db, id);
    return jsonOk(event, { requestId });
  } catch (error) {
    throw toEventHttpError(error);
  }
});
