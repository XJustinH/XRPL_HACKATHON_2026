import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { PlaceOrderRequest, type PlaceOrderResult } from "@/contracts/commerce";
import { placeOrder } from "@/features/commerce/orders";
import { NO_STORE } from "@/features/commerce/route-helpers";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { runIdempotent } from "@/lib/xrpl/idempotency";

/**
 * POST /api/orders: the signed-in customer places a merchandise order (XRPL-067/068).
 * Body `PlaceOrderRequest`: cart lines plus a delivery name and address. No payment fields exist:
 * payment is simulated, no money moves, and a body carrying card details is rejected (400).
 * 201 { data: { orders, payment: "SIMULATED" } }, one order per seller in the cart.
 *
 * Stock is decremented exactly once: in the transaction that creates the orders, and the required
 * `Idempotency-Key` header makes a retried or double-submitted request replay the first response
 * (`Idempotent-Replayed: true`) instead of ordering again.
 * 401 without a session · 400 invalid body or missing key · 409 PRODUCT_UNAVAILABLE /
 * INSUFFICIENT_STOCK · 422 when the key was already used for a different order.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const key = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (!key) throw errors.validation(undefined, `Send an ${IDEMPOTENCY_KEY_HEADER} header with an order`);
  const body = await parseJsonBody(req, PlaceOrderRequest);

  const result = await runIdempotent<PlaceOrderResult>(
    db,
    { key, scope: session.userId, route: "POST /api/orders", request: body },
    async () => ({ status: 201, body: { orders: await placeOrder(db, session, body), payment: "SIMULATED" } }),
  );
  const headers = result.replayed ? { ...NO_STORE, "Idempotent-Replayed": "true" } : NO_STORE;
  return jsonOk(result.body, { requestId, status: result.status, headers });
});
