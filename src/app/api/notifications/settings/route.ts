import { NotificationSettingsInput } from "@/contracts/community";
import { setNotificationOptOut } from "@/features/community/notifications";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * PATCH /api/notifications/settings: { optOut: boolean } (XRPL-093).
 * Opting out stops new optional notifications; opting back in starts again from that moment.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { optOut } = await parseJsonBody(req, NotificationSettingsInput);
  return jsonOk(await setNotificationOptOut(db, session.userId, optOut), { requestId });
});
