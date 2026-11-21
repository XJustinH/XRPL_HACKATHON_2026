import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackGET } from "@/app/api/integrations/spotify/callback/route";
import { GET as connectGET } from "@/app/api/integrations/spotify/connect/route";
import { GET as nowPlayingGET } from "@/app/api/integrations/spotify/now-playing/route";
import { DELETE as disconnectDELETE, GET as statusGET, PATCH as visibilityPATCH } from "@/app/api/integrations/spotify/route";
import { FriendService } from "@/features/friends/friend-service";
import { setFriendServiceForTests } from "@/features/friends/server";
import { FakeDirectory, InMemoryFriendStore } from "@/features/friends/testing/fakes";
import { createSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { resetServerEnvCache } from "@/lib/env";
import { SpotifyApiError } from "./spotify-client";
import { setSpotifyApiForTests } from "./server";
import { FakeSpotifyApi, TRACK } from "./testing/fakes";

/**
 * XRPL-092 through the real routes and Postgres (`npm run test:db`), with Spotify faked:
 * no test calls Spotify, and live verification needs a real Spotify app (see docs/spotify.md).
 */

const saved = { id: process.env.SPOTIFY_CLIENT_ID, secret: process.env.SESSION_SECRET };
process.env.SPOTIFY_CLIENT_ID = "client-123";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef-test-only";
resetServerEnvCache();

const db = getDb();
let spotify: FakeSpotifyApi;
let friends: FriendService;
let directory: FakeDirectory;

const call = (path: string, init: { method?: string; cookie?: string; body?: unknown; origin?: string } = {}) =>
  new Request(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

/** A user with a live session, as the cookie header a browser would send. */
async function signedIn(displayName: string, settings: Record<string, string> = {}) {
  const user = await db.user.create({ data: { displayName, role: "CUSTOMER", settings } });
  const { token } = await createSession(db, user.id, "ONBOARDING");
  directory.add(user.id, displayName);
  return { id: user.id, cookie: `xt_session=${token}` };
}

/** Runs the whole consent round trip the way a browser would, with Spotify approving. */
async function connectSpotify(cookie: string) {
  const started = await connectGET(call("/api/integrations/spotify/connect", { cookie }), {});
  const authorize = new URL(started.headers.get("location")!);
  const oauthCookie = started.headers.get("set-cookie")!.split(";")[0]!;
  const finished = await callbackGET(
    call(`/api/integrations/spotify/callback?code=code-1&state=${authorize.searchParams.get("state")}`, {
      cookie: `${cookie}; ${oauthCookie}`,
    }),
    {},
  );
  return { started, authorize, oauthCookie, finished };
}

const nowPlaying = async (userId: string, cookie?: string) => {
  const res = await nowPlayingGET(call(`/api/integrations/spotify/now-playing?userId=${userId}`, { cookie }), {});
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { userId: string; track: unknown } }).data.track;
};
const setVisibility = (cookie: string, visibility: string) =>
  visibilityPATCH(call("/api/integrations/spotify", { method: "PATCH", cookie, body: { visibility } }), {});

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE "User" CASCADE`);
  spotify = new FakeSpotifyApi();
  setSpotifyApiForTests(spotify);
  directory = new FakeDirectory();
  friends = new FriendService({ store: new InMemoryFriendStore(), users: directory });
  setFriendServiceForTests(friends);
  process.env.SPOTIFY_CLIENT_ID = "client-123";
});

afterAll(async () => {
  setSpotifyApiForTests(null);
  setFriendServiceForTests(null);
  // DB test files share one process: leave the environment as it was found.
  if (saved.id === undefined) delete process.env.SPOTIFY_CLIENT_ID;
  else process.env.SPOTIFY_CLIENT_ID = saved.id;
  if (saved.secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved.secret;
  resetServerEnvCache();
  await db.$disconnect();
});

describe("Spotify now-playing (XRPL-092)", () => {
  it("connects with PKCE and state, stores the tokens encrypted, and never returns them", async () => {
    const aoife = await signedIn("Aoife");
    const { started, authorize, finished } = await connectSpotify(aoife.cookie);

    expect(started.status).toBe(302);
    expect(`${authorize.origin}${authorize.pathname}`).toBe("https://accounts.spotify.com/authorize");
    expect(authorize.searchParams.get("scope")).toBe("user-read-currently-playing");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(started.headers.get("set-cookie")).toMatch(/^xt_spotify_oauth=.+HttpOnly/);

    expect(finished.status).toBe(303);
    expect(finished.headers.get("location")).toBe("/profile?spotify=connected");
    expect(finished.headers.get("set-cookie")).toMatch(/^xt_spotify_oauth=;.*Max-Age=0/);
    // The verifier sent to Spotify is the one whose hash was in the authorize URL.
    expect(spotify.exchanged?.code).toBe("code-1");
    expect(createHash("sha256").update(spotify.exchanged!.codeVerifier).digest("base64url")).toBe(
      authorize.searchParams.get("code_challenge"),
    );

    const row = await db.spotifyConnection.findUniqueOrThrow({ where: { userId: aoife.id } });
    expect(row.accessTokenEnc).toMatch(/^v1\./);
    expect(row.refreshTokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toMatch(/access-1|refresh-1/);
    expect(row).toMatchObject({ spotifyDisplayName: "Aoife on Spotify", scope: "user-read-currently-playing" });

    const status = await statusGET(call("/api/integrations/spotify", { cookie: aoife.cookie }), {});
    const playing = await nowPlayingGET(call("/api/integrations/spotify/now-playing", { cookie: aoife.cookie }), {});
    const changed = await setVisibility(aoife.cookie, "FRIENDS");
    const bodies = await Promise.all([started, finished, status, playing, changed].map((res) => res.clone().text()));
    const headers = [started, finished, status, playing, changed].map((res) => JSON.stringify([...res.headers]));
    for (const text of [...bodies, ...headers]) {
      expect(text).not.toMatch(/access-1|refresh-1/);
      expect(text).not.toContain(row.accessTokenEnc);
      expect(text).not.toContain(row.refreshTokenEnc);
    }
    expect(JSON.parse(bodies[2]!)).toEqual({
      data: { configured: true, connected: true, spotifyDisplayName: "Aoife on Spotify", visibility: "ONLY_ME" },
    });
    expect(JSON.parse(bodies[3]!)).toEqual({ data: { userId: aoife.id, track: TRACK } });
  });

  it("rejects a callback with a mismatched state, a missing cookie, or another session's cookie", async () => {
    const aoife = await signedIn("Aoife");
    const brian = await signedIn("Brian");
    const started = await connectGET(call("/api/integrations/spotify/connect", { cookie: aoife.cookie }), {});
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    const oauthCookie = started.headers.get("set-cookie")!.split(";")[0]!;
    const callback = (query: string, cookie?: string) =>
      callbackGET(call(`/api/integrations/spotify/callback?${query}`, { cookie }), {});

    const forged = await callback("code=attacker-code&state=attacker-state", `${aoife.cookie}; ${oauthCookie}`);
    const noCookie = await callback(`code=attacker-code&state=${state}`, aoife.cookie);
    const otherSession = await callback(`code=attacker-code&state=${state}`, `${brian.cookie}; ${oauthCookie}`);
    const signedOut = await callback(`code=attacker-code&state=${state}`, oauthCookie);

    for (const res of [forged, noCookie, otherSession]) {
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/profile?spotify=invalid_state");
    }
    expect(signedOut.headers.get("location")).toBe("/profile?spotify=signed_out");
    expect(spotify.calls).toEqual([]);
    expect(await db.spotifyConnection.count()).toBe(0);

    // Cancelling on Spotify's consent screen stores nothing either.
    const denied = await callback(`error=access_denied&state=${state}`, `${aoife.cookie}; ${oauthCookie}`);
    expect(denied.headers.get("location")).toBe("/profile?spotify=denied");
    expect(await db.spotifyConnection.count()).toBe(0);
  });

  it("is private by default: the owner sees it, others only after the owner opts in", async () => {
    const aoife = await signedIn("Aoife", { visibility: "PUBLIC", city: "Dublin" });
    const brian = await signedIn("Brian");
    await connectSpotify(aoife.cookie);
    spotify.calls.length = 0;

    expect(await nowPlaying(aoife.id, aoife.cookie)).toEqual(TRACK);
    expect(await nowPlaying(aoife.id, brian.cookie)).toBeNull();
    expect(await nowPlaying(aoife.id)).toBeNull();
    // Only the owner's own read reached Spotify: a viewer who may not look never uses the token.
    expect(spotify.calls).toEqual(["playing:access-1"]);

    // Friends only: Brian is not a friend yet.
    expect((await setVisibility(aoife.cookie, "FRIENDS")).status).toBe(200);
    expect(await nowPlaying(aoife.id, brian.cookie)).toBeNull();
    await friends.sendRequest(aoife.id, brian.id);
    await friends.sendRequest(brian.id, aoife.id);
    expect(await nowPlaying(aoife.id, brian.cookie)).toEqual(TRACK);
    expect(await nowPlaying(aoife.id)).toBeNull();

    // Everyone: signed-out visitors too, while the profile is public.
    await friends.remove(aoife.id, brian.id);
    expect(await nowPlaying(aoife.id, brian.cookie)).toBeNull();
    await setVisibility(aoife.cookie, "EVERYONE");
    expect(await nowPlaying(aoife.id, brian.cookie)).toEqual(TRACK);
    expect(await nowPlaying(aoife.id)).toEqual(TRACK);
    // Saving the preference kept the rest of the settings.
    expect((await db.user.findUniqueOrThrow({ where: { id: aoife.id } })).settings).toEqual({
      visibility: "PUBLIC",
      city: "Dublin",
      spotifyVisibility: "EVERYONE",
    });

    // A blocked viewer never sees it, and a private profile caps "everyone" at friends.
    await db.userBlock.create({ data: { blockerId: aoife.id, blockedId: brian.id } });
    expect(await nowPlaying(aoife.id, brian.cookie)).toBeNull();
    await db.userBlock.deleteMany();
    await db.user.update({
      where: { id: aoife.id },
      data: { settings: { visibility: "PRIVATE", spotifyVisibility: "EVERYONE" } },
    });
    expect(await nowPlaying(aoife.id, brian.cookie)).toBeNull();
    expect(await nowPlaying(aoife.id)).toBeNull();
    expect(await nowPlaying(aoife.id, aoife.cookie)).toEqual(TRACK);

    // Someone with no connection cannot set a visibility, and nothing is shown for them.
    expect((await setVisibility(brian.cookie, "EVERYONE")).status).toBe(409);
    expect(await nowPlaying(brian.id, aoife.cookie)).toBeNull();
  });

  it("refreshes an expired token, then drops the connection once access is revoked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const aoife = await signedIn("Aoife");
    await connectSpotify(aoife.cookie);
    const expire = () =>
      db.spotifyConnection.update({ where: { userId: aoife.id }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } });

    const before = await expire();
    spotify.validAccessTokens.delete("access-1");
    spotify.calls.length = 0;
    expect(await nowPlaying(aoife.id, aoife.cookie)).toEqual(TRACK);
    expect(spotify.calls).toEqual(["refresh:refresh-1", "playing:access-2"]);
    const refreshed = await db.spotifyConnection.findUniqueOrThrow({ where: { userId: aoife.id } });
    expect(refreshed.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(refreshed.accessTokenEnc).not.toBe(before.accessTokenEnc);
    expect(refreshed.refreshTokenEnc).not.toBe(before.refreshTokenEnc);
    expect(JSON.stringify(refreshed)).not.toMatch(/access-2|refresh-2/);

    // Nothing playing (HTTP 204) is an empty status, not an error, and keeps the connection.
    spotify.track = null;
    expect(await nowPlaying(aoife.id, aoife.cookie)).toBeNull();
    expect(await db.spotifyConnection.count()).toBe(1);

    // Spotify being down shows nothing and keeps the connection too.
    spotify.playingError = new SpotifyApiError("unavailable", "currently-playing 503");
    expect(await nowPlaying(aoife.id, aoife.cookie)).toBeNull();
    expect(await db.spotifyConnection.count()).toBe(1);

    // The user removed the app at Spotify: the refresh token is refused, so the connection goes.
    await expire();
    spotify.refreshError = new SpotifyApiError("invalid_grant", "token endpoint 400 invalid_grant");
    expect(await nowPlaying(aoife.id, aoife.cookie)).toBeNull();
    expect(await db.spotifyConnection.count()).toBe(0);
    const status = await statusGET(call("/api/integrations/spotify", { cookie: aoife.cookie }), {});
    expect(((await status.json()) as { data: { connected: boolean } }).data.connected).toBe(false);
    warn.mockRestore();
  });

  it("disconnects by deleting the tokens, and reports 'not configured' without a Spotify app", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const aoife = await signedIn("Aoife");
    await connectSpotify(aoife.cookie);
    await setVisibility(aoife.cookie, "EVERYONE");

    const crossSite = await disconnectDELETE(
      call("/api/integrations/spotify", { method: "DELETE", cookie: aoife.cookie, origin: "https://evil.example" }),
      {},
    );
    expect(crossSite.status).toBe(403);
    expect(await db.spotifyConnection.count()).toBe(1);

    const gone = await disconnectDELETE(call("/api/integrations/spotify", { method: "DELETE", cookie: aoife.cookie }), {});
    expect(gone.status).toBe(200);
    expect(await db.spotifyConnection.count()).toBe(0);
    expect(await nowPlaying(aoife.id, aoife.cookie)).toBeNull();
    expect(await nowPlaying(aoife.id)).toBeNull();
    // Reconnecting starts private again, whatever was chosen before.
    expect((await db.user.findUniqueOrThrow({ where: { id: aoife.id } })).settings).toEqual({});
    await connectSpotify(aoife.cookie);
    expect(await nowPlaying(aoife.id)).toBeNull();

    // Signed out: connecting and managing a connection need a session.
    expect((await connectGET(call("/api/integrations/spotify/connect"), {})).status).toBe(401);
    expect((await disconnectDELETE(call("/api/integrations/spotify", { method: "DELETE" }), {})).status).toBe(401);

    // No Spotify app on this deployment.
    delete process.env.SPOTIFY_CLIENT_ID;
    const unconfigured = await connectGET(call("/api/integrations/spotify/connect", { cookie: aoife.cookie }), {});
    expect(unconfigured.status).toBe(503);
    expect(((await unconfigured.json()) as { error: { code: string } }).error.code).toBe("SPOTIFY_NOT_CONFIGURED");
    const status = await statusGET(call("/api/integrations/spotify", { cookie: aoife.cookie }), {});
    expect(((await status.json()) as { data: { configured: boolean } }).data.configured).toBe(false);
    expect(await nowPlaying(aoife.id, aoife.cookie)).toBeNull();
    // A connection can still be removed when the app is no longer configured.
    expect((await disconnectDELETE(call("/api/integrations/spotify", { method: "DELETE", cookie: aoife.cookie }), {})).status).toBe(200);
    expect(await db.spotifyConnection.count()).toBe(0);
    error.mockRestore();
  });
});
