import { markAllNotificationsRead } from "@/features/community/notifications";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/** POST /api/notifications/read-all: mark every unread notification read (XRPL-093). */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk({ marked: await markAllNotificationsRead(db, session.userId) }, { requestId });
});
