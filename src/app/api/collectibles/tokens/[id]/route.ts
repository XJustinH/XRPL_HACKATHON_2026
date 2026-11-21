import { connection } from "next/server";

import { idOf, NO_STORE, type IdContext } from "@/features/collectibles/http";
import { getTokenStatus } from "@/features/collectibles/ledger";
import { collectibleDeps } from "@/features/collectibles/server";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";

/**
 * GET /api/collectibles/tokens/:id: one edition after reconciling whatever is in flight (its
 * mint, sale listing or purchase) with the wallet request and the validated ledger.
 * 200 { data: CollectibleTokenView }. Public for published collectibles; never names the buyer.
 */
export const GET = withApiHandler<IdContext>(async (_req, ctx, { requestId }) => {
  await connection();
  const id = await idOf(ctx);
  const token = await withLedgerErrors(() => getTokenStatus(collectibleDeps(), id));
  return jsonOk(token, { requestId, headers: NO_STORE });
});
