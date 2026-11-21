import { z } from "zod";
import { FriendResponseInput } from "@/contracts/friends";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/friends/requests/:id/respond: { accept } -> accept or decline a request sent to you (XRPL-084).
 * 404 REQUEST_NOT_FOUND if it isn't a pending request addressed to you.
 */
export const POST = withApiHandler<{ params: Promise<{ id: string }> }>(async (req, ctx, { requestId }) => {
  const session = await requireSession(req);
  const id = z.uuid().parse((await ctx.params).id);
  const { accept } = await parseJsonBody(req, FriendResponseInput);
  return jsonOk(await getFriendService().respond(session.userId, id, accept), { requestId });
});
