import { z } from "zod";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, withApiHandler } from "@/lib/http/response";

/** DELETE /api/friends/blocks/:userId: unblock someone (XRPL-084). Does not restore a friendship. */
export const DELETE = withApiHandler<{ params: Promise<{ userId: string }> }>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const other = z.uuid().parse((await ctx.params).userId);
  await getFriendService().unblock(session.userId, other);
  return jsonOk({ blocked: false }, { requestId });
});
