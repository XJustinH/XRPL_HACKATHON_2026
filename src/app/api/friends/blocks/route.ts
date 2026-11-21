import { BlockInput } from "@/contracts/friends";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/friends/blocks: { userId } -> block someone (XRPL-084). Removes any friendship or request
 * with them and stops new requests in both directions. Idempotent.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const { userId } = await parseJsonBody(req, BlockInput);
  await getFriendService().block(session.userId, userId);
  return jsonOk({ blocked: true }, { status: 201, requestId });
});
