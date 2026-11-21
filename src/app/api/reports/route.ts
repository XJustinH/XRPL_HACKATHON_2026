import { ReportInput } from "@/contracts/community";
import { createReport } from "@/features/community/reports";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/reports: { targetType: REVIEW | COMMENT | POST, targetId, reason, details? } (XRPL-083).
 * 201 for a new report; 200 with `alreadyReported: true` when this account reported the item
 * before. 404 if the content is gone, 429 past the hourly limit.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const input = await parseJsonBody(req, ReportInput);
  const report = await createReport(db, session.userId, input);
  return jsonOk(report, { status: report.alreadyReported ? 200 : 201, requestId });
});
