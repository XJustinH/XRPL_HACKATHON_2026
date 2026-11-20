import { WalletVerifyRequest, type WalletVerifyResponse } from "@/contracts";
import {
  getRequestSession,
  readWalletProofToken,
  sessionSetCookie,
  walletProofClearCookie,
} from "@/lib/auth/session";
import { completeWalletSignIn, getWalletProofService, walletProofError } from "@/lib/auth/wallet-sign-in";
import { getDb } from "@/lib/db/client";
import { toUserDto } from "@/lib/db/mappers";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig, withLedgerErrors } from "@/lib/xrpl";

/**
 * POST /api/auth/verify — finish a wallet sign-in (XRPL-012). Body `{ signRequestId }`.
 * Must come from the browser that called /api/auth/challenge. Verifies the signed SignIn
 * (see src/lib/auth/wallet-proof.ts), consumes it once, then links the wallet:
 *  - signed in → the wallet is added to this account and this session is marked proven;
 *  - signed out → signs in to the wallet's account, or creates one (201, needs onboarding).
 * Replays, other browsers, expired or unsigned requests and wrong wallets are rejected.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const { signRequestId } = await parseJsonBody(req, WalletVerifyRequest);

  const result = await withLedgerErrors(() =>
    getWalletProofService().verify({ signRequestId, browserToken: readWalletProofToken(req) }),
  );
  if (!result.ok) throw walletProofError(result.reason);

  const network = loadXrplConfig().network;
  const outcome = await completeWalletSignIn(db, {
    current: await getRequestSession(req, db),
    address: result.address,
    network,
    signRequestId,
  });

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", walletProofClearCookie());
  if (outcome.newSession) {
    headers.append("Set-Cookie", sessionSetCookie(outcome.newSession.token, outcome.newSession.expiresAt));
  }

  const body: WalletVerifyResponse = {
    user: toUserDto(outcome.user),
    wallet: { address: result.address, network, verifiedAt: outcome.verifiedAt.toISOString() },
    needsOnboarding: outcome.user.onboardedAt === null,
    newAccount: outcome.newAccount,
  };
  return jsonOk(body, { status: outcome.newAccount ? 201 : 200, requestId, headers });
});
