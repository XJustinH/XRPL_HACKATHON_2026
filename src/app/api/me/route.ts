import { z } from "zod";
import { AuthErrorCode, UpdateMeRequest } from "@/contracts";
import { loadMe } from "@/lib/auth/account";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

const noStore = { "Cache-Control": "no-store" };

/** GET /api/me — the signed-in user, linked wallets and session info. 401 without a session. */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await loadMe(db, session), { requestId, headers: noStore });
});

/**
 * PATCH /api/me — update self-service profile fields (currently `displayName`).
 * Including `role` is rejected with 403 ROLE_CHANGE_FORBIDDEN; unknown fields are 400.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const raw = await parseJsonBody(req, z.unknown());

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && "role" in raw) {
    throw new AppError(AuthErrorCode.ROLE_CHANGE_FORBIDDEN, "Your role can't be changed here.", 403);
  }
  const input = UpdateMeRequest.parse(raw);

  await db.user.update({ where: { id: session.userId }, data: input });
  return jsonOk(await loadMe(db, session), { requestId, headers: noStore });
});
