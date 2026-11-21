// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveSpotifyConfig, type SpotifyConfig } from "./config";
import { OAUTH_TTL_MS, OAuthStateError, beginAuthorization, verifyCallback } from "./oauth";
import { OAUTH_COOKIE_KEY_PURPOSE, SecretBox, TOKEN_KEY_PURPOSE } from "./secret-box";
import { HttpSpotifyClient, SpotifyApiError } from "./spotify-client";
import { SpotifyService } from "./spotify-service";
import { FakeSpotifyApi, InMemorySpotifyStore, TRACK } from "./testing/fakes";
import { canViewNowPlaying, readSpotifyVisibility } from "./visibility";

/** XRPL-092. Spotify is always faked here: these tests never touch the network. */

const SECRET = "0123456789abcdef0123456789abcdef-test-only";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const config: SpotifyConfig = {
  clientId: "client-123",
  clientSecret: null,
  redirectUri: "http://127.0.0.1:3000/api/integrations/spotify/callback",
  secret: SECRET,
};

describe("configuration", () => {
  it("is 'not configured' without a client ID or without SESSION_SECRET", () => {
    expect(resolveSpotifyConfig({ SESSION_SECRET: SECRET })).toBeNull();
    expect(resolveSpotifyConfig({ SPOTIFY_CLIENT_ID: "client-123" })).toBeNull();
    expect(resolveSpotifyConfig({ SPOTIFY_CLIENT_ID: "  ", SESSION_SECRET: SECRET })).toBeNull();
  });

  it("defaults the redirect URI to the app's callback route; the client secret is optional", () => {
    expect(
      resolveSpotifyConfig({ SPOTIFY_CLIENT_ID: "client-123", SESSION_SECRET: SECRET, APP_BASE_URL: "https://tickets.example/" }),
    ).toEqual({
      clientId: "client-123",
      clientSecret: null,
      redirectUri: "https://tickets.example/api/integrations/spotify/callback",
      secret: SECRET,
    });
  });
});

describe("token encryption", () => {
  const box = new SecretBox(SECRET, TOKEN_KEY_PURPOSE);

  it("round-trips a token without the plaintext appearing in what is stored", () => {
    const sealed = box.seal("BQD-access-token-value", USER);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("BQD-access-token-value");
    expect(Buffer.from(sealed.slice(3), "base64url").toString("latin1")).not.toContain("BQD-access-token-value");
    expect(box.open(sealed, USER)).toBe("BQD-access-token-value");
    // A fresh IV each time: the same token never produces the same ciphertext twice.
    expect(box.seal("BQD-access-token-value", USER)).not.toBe(sealed);
  });

  it("refuses another user's token, a tampered value, and a different key", () => {
    const sealed = box.seal("BQD-access-token-value", USER);
    expect(() => box.open(sealed, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toThrow();
    expect(() => box.open(`${sealed.slice(0, -2)}AA`, USER)).toThrow();
    expect(() => new SecretBox(SECRET, OAUTH_COOKIE_KEY_PURPOSE).open(sealed, USER)).toThrow();
    expect(() => new SecretBox(`${SECRET}-rotated`, TOKEN_KEY_PURPOSE).open(sealed, USER)).toThrow();
  });
});

describe("OAuth: PKCE and state", () => {
  const box = new SecretBox(SECRET, OAUTH_COOKIE_KEY_PURPOSE);
  const start = () => {
    const begun = beginAuthorization(config, box, "session-1", new Date("2026-11-21T12:00:00Z"));
    const cookieValue = decodeURIComponent(begun.setCookie.split(";")[0]!.split("=").slice(1).join("="));
    return { ...begun, cookieValue, url: new URL(begun.authorizeUrl) };
  };
  const at = new Date("2026-11-21T12:01:00Z");

  it("asks Spotify for the one scope, with an S256 challenge and a state, in an httpOnly cookie", () => {
    const { url, setCookie, state, cookieValue } = start();
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-123",
      scope: "user-read-currently-playing",
      redirect_uri: config.redirectUri,
      code_challenge_method: "S256",
      state,
    });
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/Path=\/api\/integrations\/spotify/);

    // The verifier never appears in the URL or in readable form in the cookie; only its hash is sent.
    const { verifier } = verifyCallback(box, { cookieValue, state, sessionId: "session-1" }, at);
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(url.toString()).not.toContain(verifier);
    expect(setCookie).not.toContain(verifier);
    expect(setCookie).not.toContain(state);
  });

  it("rejects a mismatched state", () => {
    const { cookieValue } = start();
    const forged = () => verifyCallback(box, { cookieValue, state: "attacker-chosen-state", sessionId: "session-1" }, at);
    expect(forged).toThrow(OAuthStateError);
    expect(forged).toThrow(/does not match/);
  });

  it("rejects a missing cookie or state, another session, an expired flow and a tampered cookie", () => {
    const { cookieValue, state } = start();
    const check = (input: { cookieValue: string | null; state: string | null; sessionId: string }, now = at) => () =>
      verifyCallback(box, input, now);
    expect(check({ cookieValue: null, state, sessionId: "session-1" })).toThrow(OAuthStateError);
    expect(check({ cookieValue, state: null, sessionId: "session-1" })).toThrow(OAuthStateError);
    expect(check({ cookieValue, state, sessionId: "session-2" })).toThrow(/does not belong to this session/);
    expect(check({ cookieValue: `${cookieValue.slice(0, -2)}AA`, state, sessionId: "session-1" })).toThrow(OAuthStateError);
    const late = new Date(new Date("2026-11-21T12:00:00Z").getTime() + OAUTH_TTL_MS);
    expect(check({ cookieValue, state, sessionId: "session-1" }, late)).toThrow(/expired/);
  });
});

describe("now playing", () => {
  const NOW = new Date("2026-11-21T12:00:00Z");
  async function connected(expiresInMs = 3_600_000) {
    const api = new FakeSpotifyApi();
    const store = new InMemorySpotifyStore();
    const tokens = new SecretBox(SECRET, TOKEN_KEY_PURPOSE);
    const service = new SpotifyService({ store, api, tokens, now: () => NOW });
    await service.connect(USER, { code: "code-1", codeVerifier: "verifier-1" });
    const row = store.rows.get(USER)!;
    row.accessTokenExpiresAt = new Date(NOW.getTime() + expiresInMs);
    api.calls.length = 0;
    return { api, store, tokens, service };
  }

  it("stores only sealed tokens and returns the current track", async () => {
    const { api, store, service } = await connected();
    expect(JSON.stringify([...store.rows.values()])).not.toMatch(/access-1|refresh-1/);
    expect(await service.nowPlaying(USER)).toEqual(TRACK);
    expect(api.calls).toEqual(["playing:access-1"]);
    expect(await service.connection(USER)).toEqual({ spotifyDisplayName: "Aoife on Spotify" });
  });

  it("returns nothing when nothing is playing, and for a user who never connected", async () => {
    const { api, store, service } = await connected();
    api.track = null;
    expect(await service.nowPlaying(USER)).toBeNull();
    expect(store.rows.has(USER)).toBe(true);
    expect(await service.nowPlaying("cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeNull();
  });

  it("refreshes an expired access token and stores the new, still sealed, pair", async () => {
    const { api, store, tokens, service } = await connected(-1_000);
    api.validAccessTokens.delete("access-1");

    expect(await service.nowPlaying(USER)).toEqual(TRACK);
    expect(api.calls).toEqual(["refresh:refresh-1", "playing:access-2"]);

    const row = store.rows.get(USER)!;
    expect(tokens.open(row.accessTokenEnc, USER)).toBe("access-2");
    expect(tokens.open(row.refreshTokenEnc, USER)).toBe("refresh-2");
    expect(row.accessTokenExpiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(JSON.stringify(row)).not.toMatch(/access-2|refresh-2/);
  });

  it("keeps the old refresh token when Spotify does not rotate it", async () => {
    const { api, store, tokens, service } = await connected(-1_000);
    api.rotateRefreshToken = false;
    expect(await service.nowPlaying(USER)).toEqual(TRACK);
    expect(tokens.open(store.rows.get(USER)!.refreshTokenEnc, USER)).toBe("refresh-1");
  });

  it("refreshes once when Spotify rejects a token that should still be valid", async () => {
    const { api, service } = await connected();
    api.validAccessTokens.delete("access-1");
    expect(await service.nowPlaying(USER)).toEqual(TRACK);
    expect(api.calls).toEqual(["playing:access-1", "refresh:refresh-1", "playing:access-2"]);
  });

  it("drops the connection when the refresh token was revoked (invalid_grant)", async () => {
    const { api, store, service } = await connected(-1_000);
    api.refreshError = new SpotifyApiError("invalid_grant", "token endpoint 400 invalid_grant");

    expect(await service.nowPlaying(USER)).toBeNull();
    expect(store.rows.has(USER)).toBe(false);
    expect(await service.connection(USER)).toBeNull();
    expect(api.calls).toEqual(["refresh:refresh-1"]);
  });

  it("drops the connection when a freshly refreshed token is still rejected (401)", async () => {
    const { api, store, service } = await connected();
    api.validAccessTokens.delete("access-1");
    api.refresh = async () => ({ accessToken: "access-dead", refreshToken: null, expiresInSeconds: 3600, scope: "" });

    expect(await service.nowPlaying(USER)).toBeNull();
    expect(store.rows.has(USER)).toBe(false);
  });

  it("does not drop a connection whose refresh token a concurrent request already rotated", async () => {
    const { api, store, tokens, service } = await connected(-1_000);
    api.validAccessTokens.add("access-9");
    api.refresh = async () => {
      // Another request refreshed first: the stored row now holds its newer pair.
      const row = store.rows.get(USER)!;
      row.accessTokenEnc = tokens.seal("access-9", USER);
      row.refreshTokenEnc = tokens.seal("refresh-9", USER);
      throw new SpotifyApiError("invalid_grant", "token endpoint 400 invalid_grant");
    };

    expect(await service.nowPlaying(USER)).toEqual(TRACK);
    expect(store.rows.has(USER)).toBe(true);
  });

  it("shows nothing, and keeps the connection, when Spotify is down, slow or rate limiting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { api, store, service } = await connected();
    api.playingError = new SpotifyApiError("unavailable", "currently-playing 503");
    expect(await service.nowPlaying(USER)).toBeNull();

    const expired = await connected(-1_000);
    expired.api.refreshError = new SpotifyApiError("unavailable", "network error or timeout");
    expect(await expired.service.nowPlaying(USER)).toBeNull();

    expect(store.rows.has(USER)).toBe(true);
    expect(expired.store.rows.has(USER)).toBe(true);
    // The log line names the failure and never a token.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/access-|refresh-/);
    warn.mockRestore();
  });
});

describe("Spotify HTTP client", () => {
  const respond = (status: number, body?: unknown) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("maps 204 to nothing, a playing track to the view, and a paused one to nothing", async () => {
    expect(await new HttpSpotifyClient(config, respond(204)).getCurrentlyPlaying("t")).toBeNull();

    const item = {
      name: "Teardrop",
      artists: [{ name: "Massive Attack" }],
      album: { name: "Mezzanine" },
      external_urls: { spotify: "https://open.spotify.com/track/67Hna13dNDkZvBpTXRIaOJ" },
    };
    const fetchPlaying = respond(200, { is_playing: true, item });
    expect(await new HttpSpotifyClient(config, fetchPlaying).getCurrentlyPlaying("access-1")).toEqual(TRACK);
    expect(fetchPlaying).toHaveBeenCalledWith(
      "https://api.spotify.com/v1/me/player/currently-playing",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer access-1" }) }),
    );

    expect(await new HttpSpotifyClient(config, respond(200, { is_playing: false, item })).getCurrentlyPlaying("t")).toBeNull();
    // An unsafe link from upstream is dropped rather than rendered.
    const unsafe = { is_playing: true, item: { ...item, external_urls: { spotify: "javascript:alert(1)" } } };
    expect((await new HttpSpotifyClient(config, respond(200, unsafe)).getCurrentlyPlaying("t"))?.url).toBeNull();
  });

  it("classifies 401, revoked refresh tokens, outages and timeouts without echoing bodies", async () => {
    await expect(new HttpSpotifyClient(config, respond(401, {})).getCurrentlyPlaying("t")).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(new HttpSpotifyClient(config, respond(429, {})).getCurrentlyPlaying("t")).rejects.toMatchObject({ kind: "unavailable" });

    const revoked = respond(400, { error: "invalid_grant", error_description: "Refresh token revoked: refresh-1" });
    const error = await new HttpSpotifyClient(config, revoked).refresh("refresh-1").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "invalid_grant" });
    expect((error as Error).message).not.toContain("refresh-1");

    const down = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    }) as unknown as typeof fetch;
    await expect(new HttpSpotifyClient(config, down).refresh("refresh-1")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("exchanges the code with the PKCE verifier, and adds the client secret only when one is set", async () => {
    const ok = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "user-read-currently-playing" };
    const publicClient = respond(200, ok);
    expect(await new HttpSpotifyClient(config, publicClient).exchangeCode({ code: "code-1", codeVerifier: "verifier-1" })).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresInSeconds: 3600,
      scope: "user-read-currently-playing",
    });
    const [url, init] = (publicClient as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://accounts.spotify.com/api/token");
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: config.redirectUri,
      code_verifier: "verifier-1",
      client_id: "client-123",
    });
    expect(init.headers).not.toHaveProperty("Authorization");

    const confidential = respond(200, ok);
    await new HttpSpotifyClient({ ...config, clientSecret: "shh" }, confidential).refresh("refresh-1");
    const [, secretInit] = (confidential as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(secretInit.headers).toMatchObject({ Authorization: `Basic ${Buffer.from("client-123:shh").toString("base64")}` });
  });
});

describe("who may see it", () => {
  const base = { profileVisibility: "PUBLIC", viewerIsOwner: false, viewerIsFriend: false, viewerIsBlocked: false } as const;

  it("is private by default, and unreadable settings read as private", () => {
    expect(readSpotifyVisibility({})).toBe("ONLY_ME");
    expect(readSpotifyVisibility(null)).toBe("ONLY_ME");
    expect(readSpotifyVisibility({ spotifyVisibility: "PUBLIC" })).toBe("ONLY_ME");
    expect(readSpotifyVisibility({ spotifyVisibility: "FRIENDS" })).toBe("FRIENDS");
  });

  it("the owner always sees it; others only as the owner chose", () => {
    expect(canViewNowPlaying({ ...base, visibility: "ONLY_ME", viewerIsOwner: true })).toBe(true);
    expect(canViewNowPlaying({ ...base, visibility: "ONLY_ME", viewerIsFriend: true })).toBe(false);
    expect(canViewNowPlaying({ ...base, visibility: "FRIENDS" })).toBe(false);
    expect(canViewNowPlaying({ ...base, visibility: "FRIENDS", viewerIsFriend: true })).toBe(true);
    expect(canViewNowPlaying({ ...base, visibility: "EVERYONE" })).toBe(true);
  });

  it("a private profile caps 'everyone' at friends, and a blocked viewer never sees it", () => {
    expect(canViewNowPlaying({ ...base, visibility: "EVERYONE", profileVisibility: "PRIVATE" })).toBe(false);
    expect(canViewNowPlaying({ ...base, visibility: "EVERYONE", profileVisibility: "PRIVATE", viewerIsFriend: true })).toBe(true);
    expect(canViewNowPlaying({ ...base, visibility: "EVERYONE", viewerIsBlocked: true })).toBe(false);
    expect(canViewNowPlaying({ ...base, visibility: "FRIENDS", viewerIsFriend: true, viewerIsBlocked: true })).toBe(false);
  });
});
