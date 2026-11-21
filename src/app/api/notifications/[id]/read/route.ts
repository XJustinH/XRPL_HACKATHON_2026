import { markNotificationRead } from "@/features/community/notifications";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/** POST /api/notifications/:id/read: mark one of your own notifications read (XRPL-093). */
export const POST = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const id = await idParam(ctx, "Notification not found");
  await markNotificationRead(db, session.userId, id);
  return jsonOk({ id, read: true }, { requestId });
});
