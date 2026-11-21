import { listMyOrders } from "@/features/commerce/orders";
import { NO_STORE } from "@/features/commerce/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/orders/mine: the signed-in customer's merchandise orders, newest first (XRPL-069).
 * 200 { data: { orders: MerchOrderDto[] } } · 401 without a session.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk({ orders: await listMyOrders(db, session) }, { requestId, headers: NO_STORE });
});
