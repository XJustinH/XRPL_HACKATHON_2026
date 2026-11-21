/**
 * Spotify configuration (XRPL-092). Server-only.
 *
 * Every variable is optional. Without a client ID the feature is "not configured": the connect
 * route answers 503 and the panel says Spotify isn't set up, and nothing else in the app changes.
 * SESSION_SECRET is needed as well, because the stored tokens and the OAuth cookie are encrypted
 * with keys derived from it (it is already mandatory in production).
 */

/** The only scope requested. Reading the current track needs nothing more. */
export const SPOTIFY_SCOPE = "user-read-currently-playing";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const SPOTIFY_API_BASE_URL = "https://api.spotify.com/v1";

export const SPOTIFY_CALLBACK_PATH = "/api/integrations/spotify/callback";

export type SpotifyConfig = {
  clientId: string;
  /** Optional: Authorization Code with PKCE works without it. */
  clientSecret: string | null;
  redirectUri: string;
  /** SESSION_SECRET, the input keying material for token and cookie encryption. */
  secret: string;
};

/** The configuration, or null when Spotify is not set up on this deployment. */
export function resolveSpotifyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SpotifyConfig | null {
  const clientId = env.SPOTIFY_CLIENT_ID?.trim();
  const secret = env.SESSION_SECRET;
  if (!clientId || !secret || secret.length < 32) return null;

  const base = (env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  const redirectUri = env.SPOTIFY_REDIRECT_URI?.trim() || `${base}${SPOTIFY_CALLBACK_PATH}`;
  try {
    const protocol = new URL(redirectUri).protocol;
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null;
  }

  return { clientId, clientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || null, redirectUri, secret };
}
