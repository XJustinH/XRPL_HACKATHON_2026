import type { NowPlayingTrack } from "@/contracts/integrations";
import { SPOTIFY_SCOPE } from "./config";
import type { SecretBox } from "./secret-box";
import { SpotifyApiError, isSpotifyFailure, type SpotifyApi, type SpotifyTokens } from "./spotify-client";
import type { SpotifyConnectionStore, StoredSpotifyConnection } from "./spotify-store";

/**
 * A user's Spotify connection and the now-playing read (XRPL-092). Server-only.
 *
 * Tokens are sealed before they reach the store and opened only here, for the single call that
 * needs them. Nothing in this class returns or logs a token.
 *
 * `nowPlaying` never throws for a Spotify-side problem. It answers "nothing" for an outage, a
 * timeout or a rate limit and keeps the connection, and it deletes the connection only when
 * Spotify says the access is gone (`invalid_grant` on refresh, or 401 with a fresh token).
 *
 * This says nothing about who may see the result: that is decided in ./now-playing.ts.
 */

/** Refresh slightly early, so a token cannot expire between the check and the call. */
const EXPIRY_SKEW_MS = 30_000;

export class SpotifyService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      store: SpotifyConnectionStore;
      api: SpotifyApi;
      tokens: SecretBox;
      now?: () => Date;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Completes the consent: exchanges the code and stores the encrypted tokens. */
  async connect(userId: string, input: { code: string; codeVerifier: string }): Promise<void> {
    const tokens = await this.deps.api.exchangeCode(input);
    if (!tokens.refreshToken) throw new SpotifyApiError("unavailable", "no refresh token was issued");
    if (tokens.scope && !tokens.scope.split(/\s+/).includes(SPOTIFY_SCOPE)) {
      throw new SpotifyApiError("unavailable", "the required scope was not granted");
    }

    // "Connected as" is a nicety; failing to read it must not fail the connection.
    const profile = await this.deps.api.getProfile(tokens.accessToken).catch(() => ({ id: null, displayName: null }));

    await this.deps.store.save({
      userId,
      spotifyUserId: profile.id,
      spotifyDisplayName: profile.displayName,
      ...this.seal(userId, tokens, tokens.refreshToken),
      scope: tokens.scope,
    });
  }

  /** Deletes the stored tokens. Idempotent. */
  async disconnect(userId: string): Promise<void> {
    await this.deps.store.remove(userId);
  }

  /** The connection as its owner may see it. Never includes tokens. */
  async connection(userId: string): Promise<{ spotifyDisplayName: string | null } | null> {
    const row = await this.deps.store.find(userId);
    return row ? { spotifyDisplayName: row.spotifyDisplayName } : null;
  }

  /** What `userId` is listening to right now, or null. */
  async nowPlaying(userId: string): Promise<NowPlayingTrack | null> {
    try {
      return await this.readNowPlaying(userId);
    } catch (error) {
      // SpotifyApiError messages are a kind and a status; other errors are reduced to their name.
      const reason = error instanceof SpotifyApiError ? error.message : error instanceof Error ? error.name : "unknown";
      console.warn(`[spotify] now-playing unavailable: ${reason}`);
      return null;
    }
  }

  private async readNowPlaying(userId: string): Promise<NowPlayingTrack | null> {
    const row = await this.deps.store.find(userId);
    if (!row) return null;

    const opened = this.open(row);
    if (!opened) {
      // Sealed under a key this deployment no longer has: unusable, so the user reconnects.
      await this.deps.store.remove(userId, row.refreshTokenEnc);
      return null;
    }

    let accessToken = opened.accessToken;
    let refreshed = false;
    if (row.accessTokenExpiresAt.getTime() <= this.now().getTime() + EXPIRY_SKEW_MS) {
      const renewed = await this.refresh(row, opened.refreshToken);
      if (!renewed) return null;
      accessToken = renewed;
      refreshed = true;
    }

    try {
      return await this.deps.api.getCurrentlyPlaying(accessToken);
    } catch (error) {
      if (!isSpotifyFailure(error, "unauthorized")) throw error;
    }

    // Rejected before its recorded expiry: refresh once and try again.
    if (!refreshed) {
      const renewed = await this.refresh(row, opened.refreshToken);
      if (!renewed) return null;
      try {
        return await this.deps.api.getCurrentlyPlaying(renewed);
      } catch (error) {
        if (!isSpotifyFailure(error, "unauthorized")) throw error;
      }
    }

    // Still rejected with a brand-new token: the access has been revoked.
    await this.deps.store.remove(userId);
    return null;
  }

  /**
   * A new access token, or null when the connection was dropped because Spotify no longer
   * honours the refresh token. Throws for transient failures, which keep the connection.
   */
  private async refresh(row: StoredSpotifyConnection, refreshToken: string): Promise<string | null> {
    let next: SpotifyTokens;
    try {
      next = await this.deps.api.refresh(refreshToken);
    } catch (error) {
      if (!isSpotifyFailure(error, "invalid_grant")) throw error;
      // Either the user revoked access, or a concurrent request rotated this refresh token first.
      const current = await this.deps.store.find(row.userId);
      if (current && current.refreshTokenEnc !== row.refreshTokenEnc) {
        return this.open(current)?.accessToken ?? null;
      }
      await this.deps.store.remove(row.userId, row.refreshTokenEnc);
      return null;
    }

    await this.deps.store.updateTokens(
      row.userId,
      row.refreshTokenEnc,
      // Spotify may or may not rotate the refresh token; keep the stored one when it does not.
      this.seal(row.userId, next, next.refreshToken ?? refreshToken),
    );
    return next.accessToken;
  }

  private seal(userId: string, tokens: SpotifyTokens, refreshToken: string) {
    return {
      accessTokenEnc: this.deps.tokens.seal(tokens.accessToken, userId),
      refreshTokenEnc: this.deps.tokens.seal(refreshToken, userId),
      accessTokenExpiresAt: new Date(this.now().getTime() + tokens.expiresInSeconds * 1000),
    };
  }

  private open(row: StoredSpotifyConnection): { accessToken: string; refreshToken: string } | null {
    try {
      return {
        accessToken: this.deps.tokens.open(row.accessTokenEnc, row.userId),
        refreshToken: this.deps.tokens.open(row.refreshTokenEnc, row.userId),
      };
    } catch {
      return null;
    }
  }
}
