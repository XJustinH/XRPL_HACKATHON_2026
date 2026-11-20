import { SellerProfilePatch } from "@/contracts";
import { requireEventManager } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import {
  getSellerProfile,
  ProfileNotFoundError,
  updateSellerProfile,
} from "@/features/profiles/profile-store";

/**
 * GET /api/profiles/sellers/me — the signed-in seller's own profile (XRPL-055).
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);

  try {
    return jsonOk(await getSellerProfile(db, session.userId), { requestId });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) throw errors.notFound(error.message);
    throw error;
  }
});

/**
 * PATCH /api/profiles/sellers/me — a seller edits their own profile (XRPL-055).
 *
 * The account edited is always the session's own: there is no id in the path or
 * the body, so this route has no way to express "edit someone else's profile".
 * That is the acceptance criterion enforced structurally rather than by a check
 * that could be forgotten.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireEventManager(session);

  const patch = await parseJsonBody(req, SellerProfilePatch);
  try {
    return jsonOk(await updateSellerProfile(db, session.userId, patch), { requestId });
  } catch (error) {
    if (error instanceof ProfileNotFoundError) throw errors.notFound(error.message);
    throw error;
  }
});
