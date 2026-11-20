import { ErrorCode, LogoutRequest } from "@/contracts";
import { getRequestSession, revokeSession, sessionClearCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/auth/logout — revoke the current session server-side and clear the cookie.
 * Optional body `{ forgetWallet: true }` also unlinks the wallet proven in this session
 * from the account (XRPL-012). Idempotent: 200 even when there is no session.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const raw = await req.text();
  let body: LogoutRequest = {};
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError(ErrorCode.INVALID_JSON, "Request body must be valid JSON", 400);
    }
    body = LogoutRequest.parse(parsed);
  }

  const db = getDb();
  const session = await getRequestSession(req, db);
  if (session) {
    if (body.forgetWallet && session.walletAddress) {
      await db.walletLink.updateMany({
        where: { userId: session.userId, address: session.walletAddress, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await revokeSession(db, session.sessionId);
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionClearCookie());
  return jsonOk({ signedOut: true }, { requestId, headers });
});
