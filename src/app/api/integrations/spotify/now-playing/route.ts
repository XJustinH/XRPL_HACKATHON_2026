import { AppId } from "@/contracts/common";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { getNowPlayingForViewer } from "@/features/integrations/spotify/server";

/**
 * GET /api/integrations/spotify/now-playing?userId=… — what someone is listening to (XRPL-092).
 *
 * `userId` defaults to the caller. Returns `{ userId, track }` where `track` is null unless the
 * user connected Spotify, something is playing, and the viewer is allowed to see it: the owner
 * always, friends or everyone only if the owner opted in (and never a blocked viewer). A signed-out
 * caller is a valid viewer and sees only statuses shared with everyone.
 *
 * "Not connected", "not allowed", "nothing playing" and "Spotify unavailable" are the same empty
 * answer, and an unknown user gets it too, so the route cannot be used to probe. Never returns a token.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await getRequestSession(req, db);

  const requested = new URL(req.url).searchParams.get("userId");
  const parsed = AppId.safeParse(requested ?? session?.userId);
  if (!parsed.success) {
    throw requested === null
      ? errors.unauthenticated("Sign in, or pass a userId")
      : errors.validation([{ path: "userId", message: "Expected a user ID" }]);
  }

  const status = await getNowPlayingForViewer(db, { userId: parsed.data, viewerId: session?.userId ?? null });
  return jsonOk(status, { requestId, headers: { "Cache-Control": "private, no-store" } });
});
