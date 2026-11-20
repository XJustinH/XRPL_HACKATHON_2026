import { OnboardingRequest } from "@/contracts";
import { onboard } from "@/lib/auth/onboarding";
import { getRequestSession, sessionSetCookie } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { toUserDto } from "@/lib/db/mappers";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/onboarding — choose CUSTOMER or SELLER (XRPL-010).
 * Body: { displayName, role }. ORGANISER is not self-service (400).
 * 201 + session cookie for a new account; 200 when the current session's user
 * had not chosen a role yet; 409 ALREADY_ONBOARDED otherwise.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const input = await parseJsonBody(req, OnboardingRequest);
  const current = await getRequestSession(req, db);
  const result = await onboard(db, current, input);

  const headers = new Headers({ "Cache-Control": "no-store" });
  if (result.newSession) {
    headers.append("Set-Cookie", sessionSetCookie(result.newSession.token, result.newSession.expiresAt));
  }
  return jsonOk({ user: toUserDto(result.user) }, { status: result.created ? 201 : 200, requestId, headers });
});
