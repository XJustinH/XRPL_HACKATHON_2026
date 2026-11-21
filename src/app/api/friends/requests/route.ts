import { FriendRequestInput } from "@/contracts/friends";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * POST /api/friends/requests: { userId } (their friend code) -> send a friend request (XRPL-084).
 * 201 PENDING, or 200 ACCEPTED when they had already asked you.
 * 400 CANNOT_FRIEND_SELF, 404 USER_NOT_FOUND, 403 FRIEND_REQUEST_NOT_ALLOWED (blocked either way),
 * 409 ALREADY_FRIENDS / REQUEST_PENDING.
 */
export const POST = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const { userId } = await parseJsonBody(req, FriendRequestInput);
  const result = await getFriendService().sendRequest(session.userId, userId);
  return jsonOk(result, { status: result.status === "PENDING" ? 201 : 200, requestId });
});
