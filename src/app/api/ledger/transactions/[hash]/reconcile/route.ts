import { TxHash } from "@/contracts";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { reconcileLedgerTransaction } from "@/lib/inventory/sales";
import { getXrplQueryService, withLedgerErrors } from "@/lib/xrpl";

/**
 * POST /api/ledger/transactions/:hash/reconcile — apply one validated XRPL transaction (XRPL-032).
 * Signed-in callers only. Records a primary sale made in the app or from another wallet; it only
 * records facts the validated ledger proves, so it is safe for any account to trigger, and repeats
 * are no-ops (ALREADY_APPLIED).
 *
 * 200 { data: LedgerReconcileResult } · 400 malformed hash · 401 signed out ·
 * 409 LEDGER_TX_NOT_VALIDATED (retry later) / LEDGER_TX_FAILED · 404 unknown hash · 503 ledger down.
 */
export const POST = withApiHandler<{ params: Promise<{ hash: string }> }>(async (req, ctx, { requestId }) => {
  const db = getDb();
  await requireSession(req, db);
  const hash = TxHash.parse((await ctx.params).hash);

  const result = await withLedgerErrors(() =>
    reconcileLedgerTransaction({ db, ledger: () => getXrplQueryService() }, hash),
  );
  return jsonOk(result, { requestId, headers: { "Cache-Control": "no-store" } });
});
