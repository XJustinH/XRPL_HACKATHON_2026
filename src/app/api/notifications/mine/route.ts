import { getInbox } from "@/features/community/notifications";
import { NO_STORE } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/notifications/mine: the caller's inbox, newest first, with the unread count and
 * whether they have opted out (XRPL-093). Reading it creates any notifications that are due.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await getInbox(db, session.userId), { requestId, headers: NO_STORE });
});
