import { getOrder } from "@/features/commerce/orders";
import { NO_STORE, idParam, type IdContext } from "@/features/commerce/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/orders/:id: one merchandise order with its items, total and status (XRPL-069).
 * Only the purchaser and the order's seller can read it. Anyone else gets 404, the same as for
 * an order that doesn't exist. 200 { data: MerchOrderDto } · 401 without a session.
 */
export const GET = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const id = await idParam(ctx, "Order");
  return jsonOk(await getOrder(db, session, id), { requestId, headers: NO_STORE });
});
