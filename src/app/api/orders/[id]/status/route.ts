import { UpdateOrderStatusRequest } from "@/contracts/commerce";
import { updateOrderStatus } from "@/features/commerce/orders";
import { NO_STORE, idParam, type IdContext } from "@/features/commerce/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * PATCH /api/orders/:id/status: the order's seller moves it along the state machine (XRPL-068).
 * Body { status }. Allowed: NEW -> PROCESSING or CANCELLED, PROCESSING -> SHIPPED or CANCELLED,
 * SHIPPED -> FULFILLED. Cancelling returns the order's items to stock.
 * 200 { data: MerchOrderDto } · 401 without a session · 404 unless the caller is the buyer or the
 * seller · 403 ORDER_NOT_SELLER for the buyer · 409 INVALID_STATUS_CHANGE.
 */
export const PATCH = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const id = await idParam(ctx, "Order");
  const body = await parseJsonBody(req, UpdateOrderStatusRequest);
  return jsonOk(await updateOrderStatus(db, session, id, body), { requestId, headers: NO_STORE });
});
