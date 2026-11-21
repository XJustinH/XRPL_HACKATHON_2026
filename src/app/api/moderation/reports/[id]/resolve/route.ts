import { ResolveReportInput } from "@/contracts/community";
import { resolveReport } from "@/features/community/reports";
import { idParam, type IdCtx } from "@/features/community/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/moderation/reports/:id/resolve: { action: HIDE | DISMISS, note? } (XRPL-083).
 * HIDE hides the reported review, comment or post and closes every open report about it. DISMISS
 * closes this report only. 403 unless the caller may moderate that content, 409 if already resolved.
 */
export const POST = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const reportId = await idParam(ctx, "Report not found");
  const input = await parseJsonBody(req, ResolveReportInput);
  return jsonOk(await resolveReport(db, session.userId, reportId, input), { requestId });
});
