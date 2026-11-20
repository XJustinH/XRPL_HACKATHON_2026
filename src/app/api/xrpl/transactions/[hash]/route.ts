import { connection } from "next/server";

import { jsonOk, withApiHandler } from "@/lib/http/response";
import { rethrowAsAppError } from "@/lib/xrpl/http";
import { getXrplQueryService } from "@/lib/xrpl/query";

/**
 * GET /api/xrpl/transactions/:hash: status of a transaction (XRPL-007, used by XRPL-014).
 * 200 { data: LedgerTxLookup } with status VALIDATED | PENDING | NOT_FOUND.
 * An unknown hash is a normal 200 with status NOT_FOUND (it may not have propagated yet).
 * Only status VALIDATED with succeeded=true may be shown as confirmed.
 */
export const GET = withApiHandler<{ params: Promise<{ hash: string }> }>(async (_req, ctx, { requestId }) => {
  await connection();
  const { hash } = await ctx.params;
  const tx = await getXrplQueryService().getTransaction(hash).catch(rethrowAsAppError);
  return jsonOk(tx, { requestId, headers: { "Cache-Control": "no-store" } });
});
