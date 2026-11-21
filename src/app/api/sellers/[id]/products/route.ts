import { connection } from "next/server";

import { listSellerProducts } from "@/features/commerce/products";
import { NO_STORE, idParam, type IdContext } from "@/features/commerce/route-helpers";
import { commerceDeps } from "@/features/commerce/server";
import { getRequestSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/sellers/:id/products: a seller's physical merchandise (XRPL-066). Public.
 * Visitors get published products only; the seller also gets their own drafts and archived ones.
 * 200 { data: { products: PhysicalProductDto[] } }.
 */
export const GET = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const sellerId = await idParam(ctx, "Seller");
  const viewer = await getRequestSession(req);
  const products = await listSellerProducts(commerceDeps(), sellerId, viewer);
  return jsonOk({ products }, { requestId, headers: NO_STORE });
});
