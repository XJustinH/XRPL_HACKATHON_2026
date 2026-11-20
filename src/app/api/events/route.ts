import { EventDraftInput, EventQuery } from "@/contracts";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { createEventDraft, listPublishedEvents } from "@/features/events/event-store";

/**
 * GET /api/events — published, not-yet-started events, soonest first
 * (XRPL-018), with search filters (XRPL-059).
 *
 * Public: no session required, and no draft can appear here whatever is passed.
 * Paging uses an opaque keyset cursor, so publishing an event mid-read cannot
 * shift a reader's page or make them miss one.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const url = new URL(req.url);
  const raw = Object.fromEntries(
    // Blank values from an unfilled form field mean "no filter", not "match
    // empty", so they are dropped before validation.
    [...url.searchParams.entries()].filter(([, value]) => value.trim() !== ""),
  );
  const parsed = EventQuery.parse(raw);

  const page = await listPublishedEvents(getDb(), parsed);
  return jsonOk(page, { requestId });
});

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
