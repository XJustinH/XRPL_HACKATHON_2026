import { requireEventOwner } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { publishEvent } from "@/features/events/event-store";
import { toEventHttpError } from "@/features/events/tier-errors";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/events/:id/publish — validate then publish a draft (XRPL-017).
 *
 * 409 NOT_PUBLISHABLE lists every outstanding blocker in `details.blockers`,
 * so the seller is not sent round the loop one problem at a time.
 */
export const POST = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id } = await ctx.params;
  await requireEventOwner(db, session, id);

  try {
    const event = await publishEvent(db, id);
    return jsonOk(event, { requestId });
  } catch (error) {
    throw toEventHttpError(error);
  }
});
