import { connection } from "next/server";

import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { requestCollectiblePurchase } from "@/features/collectibles/ledger";
import { collectibleDeps } from "@/features/collectibles/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";

/**
 * POST /api/collectibles/tokens/:id/accept-intent: a customer buys one edition (XRPL-074).
 * 201 { data: CollectibleRequestResult }: an NFTokenAcceptOffer to approve in Xaman. The offer
 * is re-checked on the ledger first; a stale one is refused with 409 and marked as gone. The
 * purchase counts only once the ledger validates it (GET /api/collectibles/tokens/:id).
 * 401 · 403 WALLET_NOT_VERIFIED · 404 · 409 not for sale, stale, own wallet, can't pay, or
 * someone is already buying it.
 */
export const POST = withApiHandler<IdContext>(async (req, ctx, { requestId }) => {
  await connection();
  const tokenId = await idOf(ctx);
  const deps = collectibleDeps();
  const session = await requireSession(req, deps.db);
  const result = await withLedgerErrors(() => requestCollectiblePurchase(deps, { session, tokenId }));
  return jsonOk(result, { requestId, status: 201, headers: NO_STORE });
});
