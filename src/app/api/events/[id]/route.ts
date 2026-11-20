import { EventPatch } from "@/contracts";
import { isEventOwner, requireEventOwner } from "@/lib/auth/permissions";
import { getRequestSession, requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler, errors } from "@/lib/http/response";
import { getEventView, getPublishedEvent, updateEvent } from "@/features/events/event-store";
import { toEventHttpError } from "@/features/events/tier-errors";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/events/:id — public event details, or the seller's own draft.
 *
 * A draft is visible only to the account that owns it. Anyone else gets 404
 * rather than 403, so the endpoint cannot be used to discover that an
 * unpublished event exists (XRPL-017).
 */
export const GET = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const { id } = await ctx.params;

  const published = await getPublishedEvent(db, id);
  if (published) return jsonOk(published, { requestId });

  const session = await getRequestSession(req, db);
  if (session && (await isEventOwner(db, session.userId, id))) {
    const own = await getEventView(db, id);
    if (own) return jsonOk(own, { requestId });
  }
  throw errors.notFound("Event not found");
});

/**
 * PATCH /api/events/:id — edit event details (XRPL-017).
 *
 * 409 FIELDS_LOCKED_BY_MINT when the patch would change a field already
 * written into minted ticket metadata; the response names the fields.
 */
export const PATCH = withApiHandler<Ctx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { id } = await ctx.params;
  await requireEventOwner(db, session, id);

  const patch = await parseJsonBody(req, EventPatch);
  try {
    const event = await updateEvent(db, id, patch);
    return jsonOk(event, { requestId });
  } catch (error) {
    throw toEventHttpError(error);
  }
});
