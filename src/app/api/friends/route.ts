import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/** GET /api/friends: your friend code, friends, incoming/outgoing requests and blocks (XRPL-084). */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  return jsonOk(await getFriendService().overview(session.userId), { requestId, headers: { "Cache-Control": "no-store" } });
});
