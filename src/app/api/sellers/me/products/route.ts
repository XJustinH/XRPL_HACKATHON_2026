import { CreateProductRequest } from "@/contracts/commerce";
import { createProduct, listSellerProducts } from "@/features/commerce/products";
import { NO_STORE } from "@/features/commerce/route-helpers";
import { commerceDeps } from "@/features/commerce/server";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/sellers/me/products: the signed-in seller creates a product (XRPL-065).
 * Body `CreateProductRequest`. The seller is always the session's account: there is no field that
 * could name another one. New products are drafts. 201 { data: PhysicalProductDto }.
 * 401 without a session · 403 ROLE_REQUIRED for non-seller accounts · 400 on invalid input.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const body = await parseJsonBody(req, CreateProductRequest);
  const product = await createProduct(commerceDeps(), session, body);
  return jsonOk(product, { requestId, status: 201, headers: NO_STORE });
});

/** GET /api/sellers/me/products: every product of the signed-in seller, drafts and archived included. */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  requireEventManager(session);
  const products = await listSellerProducts(commerceDeps(), session.userId, session);
  return jsonOk({ products }, { requestId, headers: NO_STORE });
});
