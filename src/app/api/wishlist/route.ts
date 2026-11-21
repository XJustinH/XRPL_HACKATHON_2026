import { z } from "zod";
import { AppId } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import {
  WishlistError,
  addToWishlist,
  listWishlistEventIds,
  removeFromWishlist,
} from "@/features/profiles/wishlist";

const WishlistRequest = z.object({ eventId: AppId });

function toHttp(error: unknown): unknown {
  if (!(error instanceof WishlistError)) return error;
  return new AppError(
    error.code,
    error.message,
    error.code === "EVENT_NOT_FOUND" ? 404 : 409,
  );
}

/** GET /api/wishlist — the event ids the caller has saved (XRPL-062). */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk({ eventIds: await listWishlistEventIds(db, session.userId) }, { requestId });
});

/**
 * POST /api/wishlist — save an event (XRPL-062).
 *
 * Idempotent: saving an event already saved returns the unchanged list, so
 * repeated saves cannot duplicate. Saving is independent of owning a ticket.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { eventId } = await parseJsonBody(req, WishlistRequest);

  try {
    const saved = await addToWishlist(db, session.userId, eventId);
    return jsonOk({ eventId, saved: true, count: saved.length }, { requestId });
  } catch (error) {
    throw toHttp(error);
  }
});

/** DELETE /api/wishlist — remove a saved event. Also idempotent (XRPL-062). */
export const DELETE = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { eventId } = await parseJsonBody(req, WishlistRequest);

  const saved = await removeFromWishlist(db, session.userId, eventId);
  return jsonOk({ eventId, saved: false, count: saved.length }, { requestId });
});
