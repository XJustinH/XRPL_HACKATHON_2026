import { Suspense } from "react";
import { getDb } from "@/lib/db/client";
import { NowPlayingLine } from "./now-playing-line";
import { getNowPlayingForViewer } from "./server";

/**
 * What a customer is listening to, for profile views other than their own settings (XRPL-092).
 *
 * Renders nothing unless the customer connected Spotify, something is playing, and this viewer is
 * allowed to see it. The decision is made on the server by `getNowPlayingForViewer`, so there is
 * no hidden markup for a template to leak. `viewer` is the current session, or null when signed out.
 *
 * Streams in behind its own Suspense boundary with no fallback, and any failure renders nothing.
 */
export function NowPlayingBadge({ userId, viewer }: { userId: string; viewer: { userId: string } | null }) {
  return (
    <Suspense fallback={null}>
      <NowPlayingBadgeBody userId={userId} viewerId={viewer?.userId ?? null} />
    </Suspense>
  );
}

async function NowPlayingBadgeBody({ userId, viewerId }: { userId: string; viewerId: string | null }) {
  const track = await getNowPlayingForViewer(getDb(), { userId, viewerId })
    .then((status) => status.track)
    .catch((error: unknown) => {
      console.error("[spotify] could not load a now-playing badge", error);
      return null;
    });
  if (!track) return null;

  return (
    <div className="rounded-card border border-border bg-surface-raised px-5 py-3">
      <NowPlayingLine track={track} />
    </div>
  );
}
