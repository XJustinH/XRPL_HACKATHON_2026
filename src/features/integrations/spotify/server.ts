/**
 * Server wiring for the Spotify integration (XRPL-092). Server-only.
 *
 * `getSpotify()` is null when the deployment has no Spotify app configured; callers turn that
 * into "not configured" rather than an error page. Built on each call (two HKDF derivations, no
 * I/O), so a changed environment never leaves a stale client behind.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { NowPlayingStatus, SpotifyConnectionStatus } from "@/contracts/integrations";
import { getFriendService } from "@/features/friends/server";
import { readProfileSettings } from "@/features/profiles/profile-settings";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";
import { resolveSpotifyConfig, type SpotifyConfig } from "./config";
import { OAUTH_COOKIE_KEY_PURPOSE, SecretBox, TOKEN_KEY_PURPOSE } from "./secret-box";
import { HttpSpotifyClient, type SpotifyApi } from "./spotify-client";
import { SpotifyService } from "./spotify-service";
import { PrismaSpotifyStore } from "./spotify-store";
import { canViewNowPlaying, readSpotifyVisibility } from "./visibility";

export type SpotifyRuntime = {
  config: SpotifyConfig;
  service: SpotifyService;
  /** Seals the short-lived OAuth cookie (a different key from the stored tokens). */
  oauthBox: SecretBox;
};

const g = globalThis as unknown as { __spotifyApiForTests?: SpotifyApi | null };

export function getSpotify(): SpotifyRuntime | null {
  const config = resolveSpotifyConfig();
  if (!config) return null;
  return {
    config,
    oauthBox: new SecretBox(config.secret, OAUTH_COOKIE_KEY_PURPOSE),
    service: new SpotifyService({
      store: new PrismaSpotifyStore(getDb()),
      api: g.__spotifyApiForTests ?? new HttpSpotifyClient(config),
      tokens: new SecretBox(config.secret, TOKEN_KEY_PURPOSE),
    }),
  };
}

/** Tests only: replace every Spotify HTTP call with a fake. */
export function setSpotifyApiForTests(api: SpotifyApi | null): void {
  g.__spotifyApiForTests = api;
}

export const spotifyNotConfigured = () =>
  new AppError("SPOTIFY_NOT_CONFIGURED", "Spotify isn't set up on this deployment.", 503);

/** The caller's own connection, for the profile panel and `GET /api/integrations/spotify`. */
export async function getSpotifyConnectionStatus(
  db: Pick<PrismaClient, "user" | "spotifyConnection">,
  userId: string,
): Promise<SpotifyConnectionStatus> {
  const [row, user] = await Promise.all([
    db.spotifyConnection.findUnique({ where: { userId }, select: { spotifyDisplayName: true } }),
    db.user.findUnique({ where: { id: userId }, select: { settings: true } }),
  ]);
  return {
    configured: resolveSpotifyConfig() !== null,
    connected: row !== null,
    spotifyDisplayName: row?.spotifyDisplayName ?? null,
    visibility: readSpotifyVisibility(user?.settings),
  };
}

/**
 * Friendship and blocking between a viewer and an owner, failing closed: if either answer is
 * unavailable the viewer is treated as blocked or as not a friend, never the other way round.
 */
async function relationship(
  db: Pick<PrismaClient, "userBlock">,
  viewerId: string | null,
  ownerId: string,
): Promise<{ isFriend: boolean; isBlocked: boolean }> {
  if (!viewerId) return { isFriend: false, isBlocked: false };

  let isBlocked = true;
  try {
    isBlocked =
      (await db.userBlock.count({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: ownerId },
            { blockerId: ownerId, blockedId: viewerId },
          ],
        },
      })) > 0;
  } catch (error) {
    console.error("[spotify] block check unavailable; hiding the status", error);
  }
  if (isBlocked) return { isFriend: false, isBlocked: true };

  try {
    // The friend service's own accessor (XRPL-084): accepted, and not blocked either way.
    return { isFriend: await getFriendService().areFriends(viewerId, ownerId), isBlocked: false };
  } catch {
    console.warn("[spotify] friendship check unavailable; treating the viewer as not a friend");
    return { isFriend: false, isBlocked: false };
  }
}

/**
 * `userId`'s now-playing status as `viewerId` may see it (null viewer = signed out).
 *
 * Permission is decided before Spotify is contacted, so a viewer who may not see the status
 * never causes the owner's token to be used. Not connected, not allowed, nothing playing and
 * "Spotify is down" all return the same empty status.
 */
export async function getNowPlayingForViewer(
  db: Pick<PrismaClient, "user" | "userBlock">,
  input: { userId: string; viewerId: string | null },
): Promise<NowPlayingStatus> {
  const hidden: NowPlayingStatus = { userId: input.userId, track: null };
  const spotify = getSpotify();
  if (!spotify) return hidden;

  if (input.viewerId !== input.userId) {
    const owner = await db.user.findUnique({ where: { id: input.userId }, select: { settings: true } });
    if (!owner) return hidden;

    const visibility = readSpotifyVisibility(owner.settings);
    if (visibility === "ONLY_ME") return hidden;

    const { isFriend, isBlocked } = await relationship(db, input.viewerId, input.userId);
    const allowed = canViewNowPlaying({
      visibility,
      profileVisibility: readProfileSettings(owner.settings).visibility,
      viewerIsOwner: false,
      viewerIsFriend: isFriend,
      viewerIsBlocked: isBlocked,
    });
    if (!allowed) return hidden;
  }

  return { userId: input.userId, track: await spotify.service.nowPlaying(input.userId) };
}
