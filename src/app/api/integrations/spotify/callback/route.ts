import type { SpotifyCallbackResult } from "@/contracts/integrations";
import { getRequestSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { withApiHandler } from "@/lib/http/response";
import {
  OAuthStateError,
  clearOAuthCookie,
  readOAuthCookie,
  verifyCallback,
} from "@/features/integrations/spotify/oauth";
import { getSpotify, spotifyNotConfigured } from "@/features/integrations/spotify/server";
import { SpotifyApiError } from "@/features/integrations/spotify/spotify-client";
import { setSpotifyVisibility } from "@/features/integrations/spotify/visibility";

/**
 * GET /api/integrations/spotify/callback — Spotify sends the browser back here (XRPL-092).
 *
 * The callback is honoured only if the encrypted cookie set by /connect opens in this session,
 * has not expired, and carries the same `state` Spotify returned. Then the code is exchanged with
 * the PKCE verifier and the tokens are stored encrypted. They are never sent to the browser.
 *
 * This is a page navigation, so every outcome redirects to `/profile?spotify=<result>` (see
 * `SpotifyCallbackResult`) instead of returning JSON. The cookie is single-use: it is cleared on
 * every outcome. A new connection always starts private.
 */
function finish(result: SpotifyCallbackResult, requestId: string): Response {
  const headers = new Headers({
    // Relative, so the browser stays on the host it used (and keeps its session cookie).
    Location: `/profile?spotify=${result}`,
    "Cache-Control": "no-store",
    "x-request-id": requestId,
  });
  headers.append("Set-Cookie", clearOAuthCookie());
  return new Response(null, { status: 303, headers });
}

export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  const spotify = getSpotify();
  if (!spotify) throw spotifyNotConfigured();

  const db = getDb();
  const session = await getRequestSession(req, db);
  if (!session) return finish("signed_out", requestId);

  const query = new URL(req.url).searchParams;
  let verifier: string;
  try {
    ({ verifier } = verifyCallback(spotify.oauthBox, {
      cookieValue: readOAuthCookie(req),
      state: query.get("state"),
      sessionId: session.sessionId,
    }));
  } catch (error) {
    if (!(error instanceof OAuthStateError)) throw error;
    return finish("invalid_state", requestId);
  }

  // The user pressed Cancel on Spotify's consent screen (or Spotify refused the request).
  if (query.get("error")) return finish("denied", requestId);
  const code = query.get("code");
  if (!code) return finish("failed", requestId);

  try {
    // Private first, so the new connection is never visible under an older, wider choice.
    await setSpotifyVisibility(db, session.userId, null);
    await spotify.service.connect(session.userId, { code, codeVerifier: verifier });
  } catch (error) {
    // Kind and status only: never the code, the verifier or a token.
    const reason =
      error instanceof SpotifyApiError ? error.message : error instanceof Error ? error.name : "unknown";
    console.error(`[${requestId}] [spotify] could not complete the connection: ${reason}`);
    return finish("failed", requestId);
  }
  return finish("connected", requestId);
});
