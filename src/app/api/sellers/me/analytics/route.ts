import { getStorefrontMetrics } from "@/features/analytics/storefront-metrics";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";

/**
 * GET /api/sellers/me/analytics: the signed-in seller's storefront summary (XRPL-078): ticket sales,
 * physical merchandise orders and digital collectible sales, reported separately.
 * 200 { data: StorefrontMetrics } · 401 without a session · 403 ROLE_REQUIRED for non-seller accounts.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);
  const metrics = await getStorefrontMetrics(db, session.userId, loadXrplConfig());
  return jsonOk(metrics, { requestId, headers: { "Cache-Control": "no-store" } });
});
