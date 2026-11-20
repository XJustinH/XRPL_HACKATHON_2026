import { WalletChallengeRequest } from "@/contracts";
import { getRequestSession, walletProofSetCookie } from "@/lib/auth/session";
import { getWalletProofService } from "@/lib/auth/wallet-sign-in";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl";

/**
 * POST /api/auth/challenge — start a wallet sign-in (XRPL-012).
 * Body `{ kind?: "SIGN_IN", address?: "r..." }`. Creates a one-time, expiring Xaman SignIn
 * request bound to this browser (httpOnly cookie) and returns it as a `SignRequest`
 * (QR + sign link). Poll `GET /api/wallet/sign-requests/:id`, then `POST /api/auth/verify`.
 * 503 if the wallet provider is not configured or unreachable.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const body = await parseJsonBody(req, WalletChallengeRequest);
  const current = await getRequestSession(req, db);

  const { signRequest, browserToken, expiresAt } = await withLedgerErrors(() =>
    getWalletProofService().requestSignIn({
      sessionId: current?.sessionId ?? null,
      requestedAddress: body.address ?? null,
    }),
  );

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", walletProofSetCookie(browserToken, expiresAt));
  return jsonOk(signRequest, { status: 201, requestId, headers });
});
