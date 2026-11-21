/**
 * Contract slice for optional third-party integrations: Spotify now-playing (XRPL-092).
 * Imported directly from `@/contracts/integrations` (not yet re-exported by the barrel).
 *
 * Nothing here ever carries an OAuth token: tokens stay on the server, encrypted at rest.
 */
import { z } from "zod";
import { AppId, HttpUrl } from "./common";

/**
 * Who may see a customer's now-playing status. Opt-in: the default is ONLY_ME.
 * EVERYONE still respects a private profile (then only accepted friends see it).
 */
export const SpotifyVisibility = z.enum(["ONLY_ME", "FRIENDS", "EVERYONE"]);
export type SpotifyVisibility = z.infer<typeof SpotifyVisibility>;

export const NowPlayingTrack = z.object({
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().nullable(),
  /** Link to the track on Spotify (http/https only), or null. */
  url: HttpUrl.nullable(),
});
export type NowPlayingTrack = z.infer<typeof NowPlayingTrack>;

/**
 * GET /api/integrations/spotify/now-playing?userId=…
 *
 * `track` is null when nothing is playing, when the user has not connected Spotify, when the
 * viewer is not allowed to see it, and when Spotify could not be reached. Those cases are
 * deliberately indistinguishable to anyone but the owner.
 */
export const NowPlayingStatus = z.object({
  userId: AppId,
  track: NowPlayingTrack.nullable(),
});
export type NowPlayingStatus = z.infer<typeof NowPlayingStatus>;

/** GET /api/integrations/spotify: the caller's own connection. */
export const SpotifyConnectionStatus = z.object({
  /** False when this deployment has no Spotify app configured. */
  configured: z.boolean(),
  connected: z.boolean(),
  /** The connected Spotify account's display name, when Spotify shared one. */
  spotifyDisplayName: z.string().nullable(),
  visibility: SpotifyVisibility,
});
export type SpotifyConnectionStatus = z.infer<typeof SpotifyConnectionStatus>;

/** PATCH /api/integrations/spotify */
export const SpotifyVisibilityInput = z.object({ visibility: SpotifyVisibility });
export type SpotifyVisibilityInput = z.infer<typeof SpotifyVisibilityInput>;

/** Outcome of the OAuth round trip, passed back to the profile page as `?spotify=…`. */
export const SPOTIFY_CALLBACK_RESULTS = ["connected", "denied", "invalid_state", "signed_out", "failed"] as const;
export type SpotifyCallbackResult = (typeof SPOTIFY_CALLBACK_RESULTS)[number];
