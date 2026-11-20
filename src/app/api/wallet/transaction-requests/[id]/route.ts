import { connection } from "next/server";

import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/wallet/transaction-requests/:id: status of a transaction approval (XRPL-014).
 * 200 { data: TransactionRequest }. Poll until the status is final. Only CONFIRMED (validated
 * with tesSUCCESS) may be shown as done; it carries the explorer link.
 */
export const GET = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  const request = await withLedgerErrors(() => getWalletTransactionRequests().get(id));
  return jsonOk(request, { requestId, headers: NO_STORE });
});

/**
 * DELETE /api/wallet/transaction-requests/:id: withdraw a request the user has not signed.
 * 200 { data: TransactionRequest }, normally CANCELLED. A request that was already signed
 * keeps following the ledger.
 */
export const DELETE = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  const request = await withLedgerErrors(() => getWalletTransactionRequests().cancel(id));
  return jsonOk(request, { requestId, headers: NO_STORE });
});
