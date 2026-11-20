import { connection } from "next/server";

import { CreateTestTransactionBody } from "@/contracts/xrpl";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { TEST_TRANSACTION_INSTRUCTION, testTransactionsEnabled } from "@/lib/xrpl/wallet/test-transactions";
import { getWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";

/**
 * POST /api/wallet/transaction-requests: development only (XRPL-014).
 * Body { purpose: "TEST", account }. Creates a no-op AccountSet approval for `account`, so
 * signing, submission and confirmation can be checked end to end. 201 { data: TransactionRequest }.
 *
 * Real purposes (mint, offers, purchases) are created by their own routes, which build and
 * validate the transaction on the server. This route never accepts arbitrary transactions.
 * 404 when test transactions are disabled (the default in production).
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  if (!testTransactionsEnabled()) throw errors.notFound();
  const body = await parseJsonBody(req, CreateTestTransactionBody);
  const request = await withLedgerErrors(() =>
    getWalletTransactionRequests().create({
      purpose: "TEST",
      txjson: { TransactionType: "AccountSet", Account: body.account },
      instruction: TEST_TRANSACTION_INSTRUCTION,
    }),
  );
  return jsonOk(request, { requestId, status: 201, headers: { "Cache-Control": "no-store" } });
});
