import { getRequestSession, revokeSession, sessionClearCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/auth/logout — revoke the current session server-side and clear the cookie.
 * Idempotent: 200 even when there is no session. Unlinking a wallet arrives with XRPL-012.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await getRequestSession(req, db);
  if (session) await revokeSession(db, session.sessionId);

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionClearCookie());
  return jsonOk({ signedOut: true }, { requestId, headers });
});
