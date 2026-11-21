import { connection } from "next/server";

import { idOf, type IdContext } from "@/features/collectibles/http";
import { buildCollectibleMetadata } from "@/features/collectibles/metadata";
import { getDb } from "@/lib/db/client";
import { errors, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";
import { ticketPublicBaseUrl } from "@/lib/xrpl/tickets/urls";

/**
 * GET /api/collectibles/tokens/:id/metadata: public metadata JSON for one collectible edition
 * (XRPL-072). This URL is what the NFT's on-ledger URI points to, and it resolves from the moment
 * the collectible is published, before the edition is minted.
 *
 * Returns the raw `CollectibleNftMetadata` object, not the `{ data }` envelope, because wallets
 * and explorers read NFT metadata at the top level. Cross-origin reads are allowed.
 * 404 for unknown tokens and for collectibles that are not published.
 */
export const GET = withApiHandler<IdContext>(async (_req, ctx) => {
  await connection();
  const id = await idOf(ctx);
  const token = await getDb().collectibleToken.findUnique({
    where: { id },
    include: { collectible: { include: { media: true, seller: { select: { id: true, displayName: true } } } } },
  });
  if (!token || token.collectible.status !== "PUBLISHED") throw errors.notFound("Collectible not found");

  const { collectible } = token;
  const metadata = buildCollectibleMetadata({
    token,
    collectible,
    seller: collectible.seller,
    media: collectible.media,
    network: loadXrplConfig().network,
    baseUrl: ticketPublicBaseUrl(),
  });
  return Response.json(metadata, {
    headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
  });
});
