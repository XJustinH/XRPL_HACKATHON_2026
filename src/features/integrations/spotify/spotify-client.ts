import { z } from "zod";
import { safeExternalUrl } from "@/contracts/common";
import type { NowPlayingTrack } from "@/contracts/integrations";
import { SPOTIFY_API_BASE_URL, SPOTIFY_TOKEN_URL, type SpotifyConfig } from "./config";

/**
 * Every HTTP call to Spotify (XRPL-092) lives behind `SpotifyApi`, so the rest of the feature can
 * be exercised with a fake. Server-only.
 *
 * Errors carry a coarse `kind` and an HTTP status at most. They never include a request or
 * response body, because those are where tokens travel.
 */

export type SpotifyTokens = {
  accessToken: string;
  /** Absent when Spotify keeps the current refresh token. */
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
};

export type SpotifyProfile = { id: string | null; displayName: string | null };

/**
 * - `invalid_grant`: the code or refresh token is no longer valid (expired, used, or access revoked).
 * - `unauthorized`: the API rejected the access token (HTTP 401).
 * - `unavailable`: anything else, including timeouts, rate limits and Spotify outages.
 */
export type SpotifyFailure = "invalid_grant" | "unauthorized" | "unavailable";

export class SpotifyApiError extends Error {
  constructor(
    public readonly kind: SpotifyFailure,
    detail: string,
  ) {
    super(`Spotify ${kind}: ${detail}`);
    this.name = "SpotifyApiError";
  }
}

export const isSpotifyFailure = (error: unknown, kind: SpotifyFailure): boolean =>
  error instanceof SpotifyApiError && error.kind === kind;

export interface SpotifyApi {
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<SpotifyTokens>;
  refresh(refreshToken: string): Promise<SpotifyTokens>;
  /** Public profile fields only; needs no scope beyond a valid token. */
  getProfile(accessToken: string): Promise<SpotifyProfile>;
  /** The track playing right now, or null when nothing is (HTTP 204, paused, or not a track). */
  getCurrentlyPlaying(accessToken: string): Promise<NowPlayingTrack | null>;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});

const CurrentlyPlaying = z.object({
  is_playing: z.boolean().optional(),
  item: z
    .object({
      name: z.string(),
      artists: z.array(z.object({ name: z.string() })).optional(),
      album: z.object({ name: z.string() }).nullish(),
      external_urls: z.object({ spotify: z.string().optional() }).nullish(),
    })
    .nullish(),
});

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Maps Spotify's currently-playing body to what the app shows. Anything unexpected is "nothing". */
export function toNowPlayingTrack(body: unknown): NowPlayingTrack | null {
  const parsed = CurrentlyPlaying.safeParse(body);
  if (!parsed.success || !parsed.data.is_playing || !parsed.data.item) return null;
  const { item } = parsed.data;
  if (item.name.trim() === "") return null;
  return {
    title: clip(item.name, 200),
    artists: (item.artists ?? []).slice(0, 10).map((artist) => clip(artist.name, 100)),
    album: item.album?.name ? clip(item.album.name, 200) : null,
    url: safeExternalUrl(item.external_urls?.spotify),
  };
}

/** Spotify's OAuth error codes are short lower-case words; anything else is not echoed. */
const errorCode = (body: unknown): string | null => {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : null;
};

export class HttpSpotifyClient implements SpotifyApi {
  constructor(
    private readonly config: Pick<SpotifyConfig, "clientId" | "clientSecret" | "redirectUri">,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 4_000,
  ) {}

  exchangeCode(input: { code: string; codeVerifier: string }): Promise<SpotifyTokens> {
    return this.token({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.config.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  refresh(refreshToken: string): Promise<SpotifyTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getProfile(accessToken: string): Promise<SpotifyProfile> {
    const res = await this.send(`${SPOTIFY_API_BASE_URL}/me`, { headers: this.bearer(accessToken) });
    if (res.status === 401) throw new SpotifyApiError("unauthorized", "profile 401");
    if (!res.ok) throw new SpotifyApiError("unavailable", `profile ${res.status}`);
    const body = (await res.json().catch(() => null)) as { id?: unknown; display_name?: unknown } | null;
    return {
      id: typeof body?.id === "string" ? clip(body.id, 200) : null,
      displayName: typeof body?.display_name === "string" && body.display_name.trim() ? clip(body.display_name, 100) : null,
    };
  }

  async getCurrentlyPlaying(accessToken: string): Promise<NowPlayingTrack | null> {
    const res = await this.send(`${SPOTIFY_API_BASE_URL}/me/player/currently-playing`, {
      headers: this.bearer(accessToken),
    });
    if (res.status === 204) return null;
    if (res.status === 401) throw new SpotifyApiError("unauthorized", "currently-playing 401");
    if (!res.ok) throw new SpotifyApiError("unavailable", `currently-playing ${res.status}`);
    return toNowPlayingTrack(await res.json().catch(() => null));
  }

  private bearer(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  }

  private async token(params: Record<string, string>): Promise<SpotifyTokens> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    const { clientId, clientSecret } = this.config;
    if (clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }
    const res = await this.send(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers,
      body: new URLSearchParams({ ...params, client_id: clientId }).toString(),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = errorCode(body);
      throw new SpotifyApiError(
        code === "invalid_grant" ? "invalid_grant" : "unavailable",
        `token endpoint ${res.status}${code ? ` ${code}` : ""}`,
      );
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw new SpotifyApiError("unavailable", "token endpoint returned an unexpected body");
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      expiresInSeconds: parsed.data.expires_in,
      scope: parsed.data.scope ?? "",
    };
  }

  /** One request with a hard timeout. Network failures become `unavailable`, never a raw error. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new SpotifyApiError("unavailable", "network error or timeout");
    }
  }
}
