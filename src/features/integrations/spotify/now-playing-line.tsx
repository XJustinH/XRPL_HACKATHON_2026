import type { NowPlayingTrack } from "@/contracts/integrations";

/**
 * One line of "listening to" text (XRPL-092). Presentational only: whether the viewer may see the
 * track is decided on the server before this is ever rendered. Text comes from Spotify and is
 * rendered as text; the link is already restricted to http/https.
 */
export function NowPlayingLine({ track }: { track: NowPlayingTrack }) {
  const artists = track.artists.join(", ");
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">Listening on Spotify</span>
      <span className="min-w-0 break-words">
        {track.url ? (
          <a
            href={track.url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent underline"
          >
            {track.title}
          </a>
        ) : (
          <span className="font-medium">{track.title}</span>
        )}
        {artists ? <span className="text-muted"> · {artists}</span> : null}
      </span>
    </p>
  );
}
