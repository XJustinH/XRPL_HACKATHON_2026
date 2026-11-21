import { FriendsSettingsInput } from "@/contracts/friends";
import { getFriendService } from "@/features/friends/server";
import { requireSession } from "@/lib/auth/session";
import { jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";

/**
 * PATCH /api/friends/settings: { friendsVisibility: "ONLY_ME" | "FRIENDS" } (XRPL-084).
 * Who may see your friend list. ONLY_ME is the default; a private profile never shows it.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const session = await requireSession(req);
  const { friendsVisibility } = await parseJsonBody(req, FriendsSettingsInput);
  await getFriendService().setFriendsVisibility(session.userId, friendsVisibility);
  return jsonOk({ friendsVisibility }, { requestId });
});
