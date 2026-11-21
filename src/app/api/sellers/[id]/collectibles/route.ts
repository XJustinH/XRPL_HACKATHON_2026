import { connection } from "next/server";

import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { listSellerCollectibles, toCollectibleView } from "@/features/collectibles/listings";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";

/**
 * GET /api/sellers/:id/collectibles: a seller's published collectibles (public, for their
 * storefront). 200 { data: CollectibleView[] }. Drafts are never listed.
 */
export const GET = withApiHandler<IdContext>(async (_req, ctx, { requestId }) => {
  await connection();
  const sellerId = await idOf(ctx, "Seller not found");
  const rows = await listSellerCollectibles(getDb(), sellerId, { includeDrafts: false });
  const config = loadXrplConfig();
  return jsonOk(
    rows.map((row) => toCollectibleView(row, config)),
    { requestId, headers: NO_STORE },
  );
});
