import { requireSession } from "@/lib/auth/session";
import { withApiHandler } from "@/lib/http/response";
import { beginAuthorization } from "@/features/integrations/spotify/oauth";
import { getSpotify, spotifyNotConfigured } from "@/features/integrations/spotify/server";

/**
 * GET /api/integrations/spotify/connect — start connecting Spotify (XRPL-092).
 *
 * Authorization Code with PKCE, scope `user-read-currently-playing` only. Stores the PKCE verifier
 * and a random `state` in an encrypted, httpOnly, ten-minute cookie bound to this session, then
 * redirects the browser to Spotify's consent screen. Nothing is stored unless the user approves
 * there and the callback verifies.
 *
 * 503 `SPOTIFY_NOT_CONFIGURED` when this deployment has no Spotify app; 401 when signed out.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const spotify = getSpotify();
  if (!spotify) throw spotifyNotConfigured();
  const session = await requireSession(req);

  const { authorizeUrl, setCookie } = beginAuthorization(spotify.config, spotify.oauthBox, session.sessionId);
  const headers = new Headers({ Location: authorizeUrl, "Cache-Control": "no-store", "x-request-id": requestId });
  headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
});
