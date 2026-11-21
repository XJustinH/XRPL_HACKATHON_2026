import { connection } from "next/server";

import { UpdateProductRequest } from "@/contracts/commerce";
import { getProduct, updateProduct } from "@/features/commerce/products";
import { NO_STORE, idParam, type IdContext } from "@/features/commerce/route-helpers";
import { commerceDeps } from "@/features/commerce/server";
import { getRequestSession, requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/products/:id: one physical product (XRPL-066). Public for published products; drafts
 * and archived products are 404 for everyone but their seller. 200 { data: PhysicalProductDto }.
 */
export const GET = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const id = await idParam(ctx, "Product");
  const viewer = await getRequestSession(req);
  return jsonOk(await getProduct(commerceDeps(), id, viewer), { requestId, headers: NO_STORE });
});

/**
 * PATCH /api/products/:id: the product's own seller edits its details or status (XRPL-065).
 * Body `UpdateProductRequest` (stock changes go through POST /api/products/:id/stock).
 * 401 without a session · 404 unknown product · 403 PRODUCT_NOT_OWNED for anyone but its seller ·
 * 409 INVALID_STATUS_CHANGE.
 */
export const PATCH = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const id = await idParam(ctx, "Product");
  const body = await parseJsonBody(req, UpdateProductRequest);
  return jsonOk(await updateProduct(commerceDeps(), session, id, body), { requestId, headers: NO_STORE });
});
