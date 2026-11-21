import { connection } from "next/server";

import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { requestCollectibleSale } from "@/features/collectibles/ledger";
import { collectibleDeps } from "@/features/collectibles/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";

/**
 * POST /api/collectibles/tokens/:id/sale-intent: the seller lists one minted edition for sale
 * (XRPL-074). 201 { data: CollectibleRequestResult }: an NFTokenCreateOffer (sell, at the
 * collectible's price) to approve in Xaman. The listing is live only once the ledger validates it.
 * 401 · 403 not the seller / WALLET_NOT_VERIFIED · 404 · 409 not minted, sold, already listed,
 * or the connected wallet does not hold the NFT.
 */
export const POST = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const tokenId = await idOf(ctx);
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const result = await withLedgerErrors(() => requestCollectibleSale(deps, { session, tokenId }));
  return jsonOk(result, { requestId, status: 201, headers: NO_STORE });
});
