import { z } from "zod";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * DELETE /api/friends/:userId: unfriend, or cancel/decline a pending request with this person (XRPL-084).
 * Anything shared with them afterwards is no longer visible to them. 404 NOT_CONNECTED otherwise.
 */
export const DELETE = withApiHandler<{ params: Promise<{ userId: string }> }>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const other = z.uuid().parse((await ctx.params).userId);
  await getFriendService().remove(session.userId, other);
  return jsonOk({ removed: true }, { requestId });
});
