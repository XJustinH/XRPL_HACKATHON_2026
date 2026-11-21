import { SpotifyVisibilityInput } from "@/contracts/integrations";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { AppError, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { getSpotifyConnectionStatus } from "@/features/integrations/spotify/server";
import { PrismaSpotifyStore } from "@/features/integrations/spotify/spotify-store";
import { setSpotifyVisibility } from "@/features/integrations/spotify/visibility";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/integrations/spotify — the caller's own Spotify connection (XRPL-092):
 * `{ configured, connected, spotifyDisplayName, visibility }`. Never includes a token.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  return jsonOk(await getSpotifyConnectionStatus(db, session.userId), { requestId, headers: NO_STORE });
});

/**
 * PATCH /api/integrations/spotify — `{ visibility: "ONLY_ME" | "FRIENDS" | "EVERYONE" }`.
 *
 * Who may see the caller's now-playing status. The account changed is always the session's own.
 * Sharing is a second, separate opt-in after connecting, so it needs a connection first.
 */
export const PATCH = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  const { visibility } = await parseJsonBody(req, SpotifyVisibilityInput);

  if (!(await new PrismaSpotifyStore(db).find(session.userId))) {
    throw new AppError("SPOTIFY_NOT_CONNECTED", "Connect Spotify before choosing who can see it.", 409);
  }
  await setSpotifyVisibility(db, session.userId, visibility);
  return jsonOk({ visibility }, { requestId, headers: NO_STORE });
});

/**
 * DELETE /api/integrations/spotify — disconnect (XRPL-092).
 *
 * Deletes the stored tokens and resets the visibility preference to private. Idempotent, and it
 * works even if Spotify is no longer configured, so a connection can always be removed. Spotify
 * has no API for an app to revoke its own grant: the user removes it at spotify.com/account/apps.
 */
export const DELETE = withApiHandler(async (req, _ctx, { requestId }) => {
  const db = getDb();
  const session = await requireSession(req, db);
  await new PrismaSpotifyStore(db).remove(session.userId);
  await setSpotifyVisibility(db, session.userId, null);
  return jsonOk({ connected: false }, { requestId, headers: NO_STORE });
});
