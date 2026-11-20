import { z } from "zod";
import { EventDraftInput } from "@/contracts";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { createEventDraft, listPublishedEvents } from "@/features/events/event-store";

/**
 * Pagination accepted by the public listing.
 *
 * Only the fields XRPL-018 actually honours. Text, city, date and price filters
 * arrive with XRPL-059; they are left out rather than accepted and ignored,
 * which would look like a working filter that silently does nothing.
 */
const PublicEventQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

/**
 * GET /api/events — published, not-yet-started events, soonest first (XRPL-018).
 *
 * Public: no session required, and no draft can appear here. Paging uses an
 * opaque keyset cursor, so publishing an event mid-read cannot shift a reader's
 * page or make them miss one.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const url = new URL(req.url);
  const parsed = PublicEventQuery.parse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });

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
