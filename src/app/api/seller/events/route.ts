import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { listSellerEvents } from "@/features/events/event-store";

/**
 * GET /api/seller/events — the signed-in seller's own events, drafts included.
 *
 * Separate from the public `GET /api/events` so that one route never has to
 * decide between public and private semantics based on who is calling. Scoped
 * to the caller's own account, so another seller's drafts are never returned.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);

  const events = await listSellerEvents(db, session.userId);
  return jsonOk({ items: events }, { requestId });
});
