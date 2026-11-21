import { z } from "zod";
import { getFriendService } from "@/features/friends/server";
import { getRequestSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/users/:id/friends: someone's friend list, only if they let you see it (XRPL-084).
 * 200 { visible: false, friends: [] } when hidden, so a hidden list is indistinguishable from an
 * empty one to people not allowed to see it. 404 for an unknown user.
 */
export const GET = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const target = z.uuid().parse((await ctx.params).id);
  const session = await getRequestSession(req);
  const data = await getFriendService().friendsOf(session?.userId ?? null, target);
  return jsonOk(data, { requestId, headers: { "Cache-Control": "no-store" } });
});
