import { EVENT_MANAGER_ROLES } from "@/contracts";
import { SellerPostInput } from "@/contracts/community";
import { createPost, getSellerPostsDashboard } from "@/features/community/posts";
import { NO_STORE } from "@/features/community/route-helpers";
import { requireRole } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/sellers/me/posts: the seller's own posts (hidden ones included) with engagement
 * totals for the dashboard (XRPL-080, XRPL-081).
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireRole(session, EVENT_MANAGER_ROLES);
  return jsonOk(await getSellerPostsDashboard(db, session.userId), { requestId, headers: NO_STORE });
});

/**
 * POST /api/sellers/me/posts: { body, imageUrl? } -> 201 post (XRPL-080).
 *
 * Seller and organiser accounts only: 403 ROLE_REQUIRED for a customer. The author is always the
 * session's own account. 400 when the text or image link breaks the content rules, 429 past the
 * hourly limit.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  requireRole(session, EVENT_MANAGER_ROLES);
  const input = await parseJsonBody(req, SellerPostInput);
  return jsonOk(await createPost(db, session.userId, input), { status: 201, requestId });
});
