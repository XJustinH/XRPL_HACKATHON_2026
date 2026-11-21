import { AdjustStockRequest } from "@/contracts/commerce";
import { adjustProductStock } from "@/features/commerce/products";
import { NO_STORE, idParam, type IdContext } from "@/features/commerce/route-helpers";
import { commerceDeps } from "@/features/commerce/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/products/:id/stock: the product's own seller adds or removes units (XRPL-065).
 * Body { delta }. The change is atomic, so it can't overwrite units sold in the meantime.
 * 401 without a session · 404 unknown product · 403 PRODUCT_NOT_OWNED ·
 * 409 INSUFFICIENT_STOCK when it would take stock below zero.
 */
export const POST = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const id = await idParam(ctx, "Product");
  const body = await parseJsonBody(req, AdjustStockRequest);
  return jsonOk(await adjustProductStock(commerceDeps(), session, id, body), { requestId, headers: NO_STORE });
});
