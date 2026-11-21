import { listSellerOrders } from "@/features/commerce/orders";
import { NO_STORE } from "@/features/commerce/route-helpers";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/sellers/me/orders: merchandise orders placed with the signed-in seller, newest first
 * (XRPL-068). 200 { data: { orders: MerchOrderDto[] } } · 401 without a session ·
 * 403 ROLE_REQUIRED for non-seller accounts.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);
  return jsonOk({ orders: await listSellerOrders(db, session) }, { requestId, headers: NO_STORE });
});
