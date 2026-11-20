import { DemoSessionRequest } from "@/contracts";
import { startDemoSession } from "@/lib/auth/onboarding";
import { getRequestSession, sessionSetCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { toUserDto } from "@/lib/db/mappers";
import { getServerEnv } from "@/lib/env";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/auth/demo-session — sign in as a seeded demo persona (hackathon demo only).
 * Body: { userId }. Replaces any current session. 404 when demo login is disabled or
 * the account is not a demo persona, so real accounts can never be assumed this way.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  if (!getServerEnv().DEMO_LOGIN_ENABLED) throw errors.notFound("Demo persona not found");

  const db = getDb();
  const { userId } = await parseJsonBody(req, DemoSessionRequest);
  const current = await getRequestSession(req, db);
  const { user, token, expiresAt } = await startDemoSession(db, userId, current);

  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", sessionSetCookie(token, expiresAt));
  return jsonOk({ user: toUserDto(user) }, { requestId, headers });
});
