import type { SellerPostsFeedData } from "@/contracts/community";
import { listSellerPosts } from "@/features/community/posts";
import { idParam, NO_STORE, type IdCtx } from "@/features/community/route-helpers";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/sellers/:id/posts: a seller's public feed, newest first (XRPL-080).
 * Public. Hidden posts are never returned. `likedByViewer` reflects the caller when signed in.
 */
export const GET = withApiHandler<IdCtx>(async (req, ctx, { requestId }) => {
  const db = getDb();
  const sellerId = await idParam(ctx, "Seller not found");
  const session = await getRequestSession(req, db);
  const data: SellerPostsFeedData = {
    sellerId,
    posts: await listSellerPosts(db, sellerId, session?.userId ?? null),
  };
  return jsonOk(data, { requestId, headers: NO_STORE });
});
