import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseCookieHeader, serializeCookie } from "@/lib/auth/cookies";
import { cookieIsSecure } from "@/lib/auth/session";
import { SPOTIFY_AUTHORIZE_URL, SPOTIFY_SCOPE, type SpotifyConfig } from "./config";
import type { SecretBox } from "./secret-box";

/**
 * Authorization Code with PKCE for Spotify (XRPL-092). Server-only.
 *
 * Starting the flow creates a random PKCE verifier and a random `state`, and keeps both in an
 * encrypted, httpOnly, ten-minute cookie. The cookie is sealed with the session ID as additional
 * authenticated data, so it only opens in the session that started the flow. The callback is
 * accepted only if that cookie opens, has not expired, and its `state` equals the one Spotify
 * sent back. That is what stops a forged callback from attaching someone else's Spotify account.
 */

export const OAUTH_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/integrations/spotify";

type PendingAuthorization = { state: string; verifier: string; expiresAt: number };

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

export function oauthCookieName(secure = cookieIsSecure()): string {
  return secure ? "__Secure-xt_spotify_oauth" : "xt_spotify_oauth";
}

/** RFC 7636: a 43-character verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

function cookie(value: string, expiresAt: Date, maxAge: number): string {
  return serializeCookie(oauthCookieName(), value, {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: cookieIsSecure(),
    // Lax, not Strict: the callback is a top-level navigation coming back from Spotify.
    sameSite: "Lax",
    expires: expiresAt,
    maxAge,
  });
}

export function clearOAuthCookie(): string {
  return cookie("", new Date(0), 0);
}

export function readOAuthCookie(req: Request): string | null {
  return parseCookieHeader(req.headers.get("cookie")).get(oauthCookieName()) ?? null;
}

/** Where to send the browser, and the cookie that must accompany the redirect. */
export function beginAuthorization(
  config: SpotifyConfig,
  box: SecretBox,
  sessionId: string,
  now = new Date(),
): { authorizeUrl: string; setCookie: string; state: string } {
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + OAUTH_TTL_MS);
  const pending: PendingAuthorization = { state, verifier, expiresAt: expiresAt.getTime() };

  const url = new URL(SPOTIFY_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: SPOTIFY_SCOPE,
    redirect_uri: config.redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
    // Always show Spotify's consent screen, so connecting is an explicit choice every time.
    show_dialog: "true",
  }).toString();

  return {
    authorizeUrl: url.toString(),
    setCookie: cookie(box.seal(JSON.stringify(pending), sessionId), expiresAt, OAUTH_TTL_MS / 1000),
    state,
  };
}

/**
 * Checks a callback against the flow this session started and returns its PKCE verifier.
 * Throws `OAuthStateError` for a missing, foreign, expired or mismatched state.
 */
export function verifyCallback(
  box: SecretBox,
  input: { cookieValue: string | null; state: string | null; sessionId: string },
  now = new Date(),
): { verifier: string } {
  if (!input.cookieValue || !input.state) throw new OAuthStateError("No Spotify authorisation is in progress");

  let pending: PendingAuthorization;
  try {
    // Fails for a cookie that was altered, or sealed for a different session.
    pending = JSON.parse(box.open(input.cookieValue, input.sessionId)) as PendingAuthorization;
  } catch {
    throw new OAuthStateError("The Spotify authorisation does not belong to this session");
  }
  if (typeof pending.state !== "string" || typeof pending.verifier !== "string" || typeof pending.expiresAt !== "number") {
    throw new OAuthStateError("The Spotify authorisation is malformed");
  }
  if (pending.expiresAt <= now.getTime()) throw new OAuthStateError("The Spotify authorisation expired");

  const expected = Buffer.from(pending.state, "utf8");
  const received = Buffer.from(input.state, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new OAuthStateError("The Spotify authorisation state does not match");
  }
  return { verifier: pending.verifier };
}
