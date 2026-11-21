import type { ModerationQueue } from "@/contracts/community";
import { listOpenReports } from "@/features/community/reports";
import { NO_STORE } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/moderation/reports: open reports the caller may resolve, oldest first (XRPL-083).
 * Moderators see every report. A seller sees reports about other people's comments on their own
 * posts and reviews of their own events. Everyone else gets an empty list.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const data: ModerationQueue = { reports: await listOpenReports(db, session.userId) };
  return jsonOk(data, { requestId, headers: NO_STORE });
});
