import { connection } from "next/server";

import { CreateSignRequestBody } from "@/contracts/xrpl";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";

/**
 * POST /api/wallet/sign-requests: ask the user's wallet (Xaman) to sign (XRPL-011).
 * Body { kind: "SIGN_IN" }. 201 { data: SignRequest } with a QR code and sign link.
 * Transaction requests (mint, offers, purchases) are added by XRPL-014.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  await parseJsonBody(req, CreateSignRequestBody);
  const request = await withLedgerErrors(() => getWalletSignRequests().createSignIn());
  return jsonOk(request, { requestId, status: 201, headers: { "Cache-Control": "no-store" } });
});
