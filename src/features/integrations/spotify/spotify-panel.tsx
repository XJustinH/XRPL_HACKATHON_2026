import { Suspense } from "react";
import type { NowPlayingTrack, SpotifyConnectionStatus } from "@/contracts/integrations";
import { card, notice, primaryButton } from "@/features/wallet/styles";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { NowPlayingLine } from "./now-playing-line";
import { getNowPlayingForViewer, getSpotifyConnectionStatus } from "./server";
import { SpotifyControls, SpotifyResultNotice } from "./spotify-controls";

/**
 * The signed-in user's Spotify settings (XRPL-092), for the profile page: connect, or "connected
 * as" with the current track, who can see it, and disconnect.
 *
 * A Server Component that reads the session itself, so it is mounted with no props. It streams in
 * behind its own Suspense boundary: a slow Spotify never holds up the page around it, and a
 * Spotify failure shows "nothing playing", never an error page.
 */
export function SpotifyPanel({ className = "mt-6" }: { className?: string }) {
  return (
    <section aria-labelledby="spotify-heading" className={`${className} ${card}`}>
      <h2 id="spotify-heading" className="text-lg font-semibold">
        Spotify
      </h2>
      <Suspense fallback={<p className="mt-2 text-sm text-muted">Checking your Spotify connection…</p>}>
        <SpotifyPanelBody />
      </Suspense>
    </section>
  );
}

type PanelView = {
  status: SpotifyConnectionStatus;
  track: NowPlayingTrack | null;
  /** The connection existed when the panel started loading and was removed while reading the track. */
  dropped: boolean;
};

async function loadPanel(userId: string): Promise<PanelView | null> {
  try {
    const db = getDb();
    const status = await getSpotifyConnectionStatus(db, userId);
    if (!status.configured || !status.connected) return { status, track: null, dropped: false };

    // Reading the track is also what notices revoked access and removes the connection.
    const { track } = await getNowPlayingForViewer(db, { userId, viewerId: userId });
    if (track) return { status, track, dropped: false };

    const after = await getSpotifyConnectionStatus(db, userId);
    return { status: after, track: null, dropped: !after.connected };
  } catch (error) {
    console.error("[spotify] could not load the Spotify panel", error);
    return null;
  }
}

async function SpotifyPanelBody() {
  const session = await getCurrentSession();
  if (!session) return <p className="mt-2 text-sm text-muted">Sign in to connect Spotify.</p>;

  const view = await loadPanel(session.userId);
  if (!view) {
    return (
      <p role="alert" className={`mt-3 ${notice.critical}`}>
        Your Spotify settings could not be loaded. Refresh to try again.
      </p>
    );
  }
  const { status, track, dropped } = view;

  if (!status.configured) {
    return (
      <p className="mt-2 text-sm text-muted">
        Spotify isn&apos;t set up on this deployment, so there is nothing to connect.
      </p>
    );
  }

  const resultNotice = (
    <Suspense fallback={null}>
      <SpotifyResultNotice connected={status.connected} />
    </Suspense>
  );

  if (!status.connected) {
    return (
      <>
        {resultNotice}
        {dropped ? (
          <p role="status" className={`mt-4 ${notice.caution}`}>
            Spotify is no longer connected: the access was removed or has expired. Connect again to use it.
          </p>
        ) : null}
        <p className="mt-2 text-sm text-muted">
          Optional. Connect Spotify to show what you&apos;re listening to on your profile. We only ask
          to read the track that is playing right now. It stays visible to you alone until you choose
          to share it, and you can disconnect at any time.
        </p>
        {session.isDemo ? (
          <p className={`mt-3 ${notice.caution}`}>
            This is a shared demo account: anyone signed in as it can see and change a Spotify
            connection made here.
          </p>
        ) : null}
        {/* A plain link: this leaves the app for Spotify's consent screen. */}
        <a href="/api/integrations/spotify/connect" className={`mt-4 min-h-11 ${primaryButton}`}>
          Connect Spotify
        </a>
      </>
    );
  }

  return (
    <>
      {resultNotice}
      <p className="mt-2 text-sm">
        Connected
        {status.spotifyDisplayName ? (
          <>
            {" "}
            as <span className="font-medium">{status.spotifyDisplayName}</span>
          </>
        ) : null}
        .
      </p>
      <div className="mt-3 rounded-lg bg-surface px-4 py-3">
        {track ? <NowPlayingLine track={track} /> : <p className="text-sm text-muted">Nothing playing right now.</p>}
      </div>
      <SpotifyControls initialVisibility={status.visibility} />
    </>
  );
}
