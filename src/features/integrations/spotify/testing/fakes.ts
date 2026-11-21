/** Stand-ins for Spotify and its storage (XRPL-092). Test use only: no test ever calls Spotify. */
import type { NowPlayingTrack } from "@/contracts/integrations";
import { SpotifyApiError, type SpotifyApi, type SpotifyProfile, type SpotifyTokens } from "../spotify-client";
import type { SealedTokens, SpotifyConnectionStore, StoredSpotifyConnection } from "../spotify-store";

export const TRACK: NowPlayingTrack = {
  title: "Teardrop",
  artists: ["Massive Attack"],
  album: "Mezzanine",
  url: "https://open.spotify.com/track/67Hna13dNDkZvBpTXRIaOJ",
};

/**
 * A scriptable Spotify. Access tokens are valid only while listed in `validAccessTokens`, so a
 * test expires or revokes one by removing it.
 */
export class FakeSpotifyApi implements SpotifyApi {
  readonly calls: string[] = [];
  readonly validAccessTokens = new Set(["access-1"]);
  /** What is playing; null = nothing (HTTP 204). */
  track: NowPlayingTrack | null = TRACK;
  /** Set to make the next calls fail the way Spotify would. */
  refreshError: SpotifyApiError | null = null;
  playingError: SpotifyApiError | null = null;
  /** Rotate the refresh token on refresh, as Spotify does for PKCE clients. */
  rotateRefreshToken = true;
  exchanged: { code: string; codeVerifier: string } | null = null;
  private issued = 1;

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<SpotifyTokens> {
    this.calls.push("exchange");
    this.exchanged = input;
    return { accessToken: "access-1", refreshToken: "refresh-1", expiresInSeconds: 3600, scope: "user-read-currently-playing" };
  }

  async refresh(refreshToken: string): Promise<SpotifyTokens> {
    this.calls.push(`refresh:${refreshToken}`);
    if (this.refreshError) throw this.refreshError;
    this.issued += 1;
    const accessToken = `access-${this.issued}`;
    this.validAccessTokens.add(accessToken);
    return {
      accessToken,
      refreshToken: this.rotateRefreshToken ? `refresh-${this.issued}` : null,
      expiresInSeconds: 3600,
      scope: "user-read-currently-playing",
    };
  }

  async getProfile(): Promise<SpotifyProfile> {
    this.calls.push("profile");
    return { id: "spotify-user-1", displayName: "Aoife on Spotify" };
  }

  async getCurrentlyPlaying(accessToken: string): Promise<NowPlayingTrack | null> {
    this.calls.push(`playing:${accessToken}`);
    if (!this.validAccessTokens.has(accessToken)) throw new SpotifyApiError("unauthorized", "currently-playing 401");
    if (this.playingError) throw this.playingError;
    return this.track;
  }
}

export class InMemorySpotifyStore implements SpotifyConnectionStore {
  readonly rows = new Map<string, StoredSpotifyConnection>();

  async find(userId: string) {
    const row = this.rows.get(userId);
    return row ? { ...row } : null;
  }
  async save(connection: StoredSpotifyConnection) {
    this.rows.set(connection.userId, { ...connection });
  }
  async updateTokens(userId: string, replacingRefreshTokenEnc: string, next: SealedTokens) {
    const row = this.rows.get(userId);
    if (!row || row.refreshTokenEnc !== replacingRefreshTokenEnc) return false;
    this.rows.set(userId, { ...row, ...next });
    return true;
  }
  async remove(userId: string, onlyIfRefreshTokenEnc?: string) {
    const row = this.rows.get(userId);
    if (row && (!onlyIfRefreshTokenEnc || row.refreshTokenEnc === onlyIfRefreshTokenEnc)) this.rows.delete(userId);
  }
}
