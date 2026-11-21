import { CartQuoteRequest } from "@/contracts/commerce";
import { quoteCart } from "@/features/commerce/orders";
import { NO_STORE } from "@/features/commerce/route-helpers";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/cart/quote: current names, prices, availability and subtotal for a cart (XRPL-067).
 * Body { items: [{ productId, quantity }] }. Public and read-only: it uses only published product
 * data, reserves no stock and takes no payment. 200 { data: CartQuote }.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const body = await parseJsonBody(req, CartQuoteRequest);
  return jsonOk(await quoteCart(getDb(), body), { requestId, headers: NO_STORE });
});
