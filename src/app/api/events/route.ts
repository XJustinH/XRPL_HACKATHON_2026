import { EventDraftInput } from "@/contracts";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { createEventDraft, listSellerEvents } from "@/features/events/event-store";

/**
 * POST /api/events — a seller creates an event draft (XRPL-015).
 *
 * 401 without a session, 403 unless the account is a SELLER or ORGANISER that
 * has completed onboarding. The event is always created as a DRAFT and owned by
 * the session's own account: `sellerId` is never taken from the request body,
 * so a seller cannot create an event attributed to someone else.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);

  const input = await parseJsonBody(req, EventDraftInput);
  const event = await createEventDraft(db, session.userId, input);

  return jsonOk(event, { status: 201, requestId });
});

/**
 * GET /api/events — the signed-in seller's own events, drafts included.
 *
 * Public event discovery is a separate, published-only listing (XRPL-018); this
 * route is scoped to the caller's own events and never exposes another
 * seller's drafts.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);

  const events = await listSellerEvents(db, session.userId);
  return jsonOk({ items: events }, { requestId });
});
