import { z } from "zod";
import { AppId } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import {
  FollowError,
  followSeller,
  listFollowedSellers,
  unfollowSeller,
} from "@/features/profiles/follows";

const FollowRequest = z.object({ sellerId: AppId });

function toHttp(error: unknown): unknown {
  if (!(error instanceof FollowError)) return error;
  // All three are conflicts with the request's own terms, not server faults.
  return new AppError(error.code, error.message, error.code === "NOT_A_SELLER" ? 404 : 409);
}

/**
 * GET /api/follows — the accounts the caller follows (XRPL-061).
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk({ items: await listFollowedSellers(db, session.userId) }, { requestId });
});

/**
 * POST /api/follows — follow a seller (XRPL-061).
 *
 * Idempotent: following an account already followed returns the unchanged list
 * rather than erroring or creating a duplicate, so a double-submitted form is
 * harmless. The follower is always the session's own account.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { sellerId } = await parseJsonBody(req, FollowRequest);

  try {
    const follows = await followSeller(db, session.userId, sellerId);
    return jsonOk({ sellerId, following: true, count: follows.length }, { requestId });
  } catch (error) {
    throw toHttp(error);
  }
});

/**
 * DELETE /api/follows — unfollow a seller (XRPL-061).
 *
 * Also idempotent: unfollowing something not followed succeeds.
 */
export const DELETE = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { sellerId } = await parseJsonBody(req, FollowRequest);

  const follows = await unfollowSeller(db, session.userId, sellerId);
  return jsonOk({ sellerId, following: false, count: follows.length }, { requestId });
});
