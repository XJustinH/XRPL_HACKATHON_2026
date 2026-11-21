"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EventView } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { requestJson } from "./api-client";
import {
  hasMintedTickets,
  mintedTicketCount,
  publishBlockers,
  type PublishBlocker,
} from "./publish-rules";

/**
 * Publish and return-to-draft controls (XRPL-017).
 *
 * Blockers are shown up front so a seller sees everything outstanding rather
 * than discovering one problem per attempt. The server re-checks on publish,
 * and a blocker list it returns replaces the locally computed one.
 */
export function PublishPanel({
  event: initialEvent,
}: {
  event: EventView;
}) {
  const router = useRouter();
  const [event, setEvent] = useState(initialEvent);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverBlockers, setServerBlockers] = useState<PublishBlocker[] | null>(null);

  // Take the fresh event when the page re-renders with one (e.g. `router.refresh()` after a tier
  // is added), so the blockers and the Publish button reflect it without a reload.
  const [seenEvent, setSeenEvent] = useState(initialEvent);
  if (initialEvent !== seenEvent) {
    setSeenEvent(initialEvent);
    setEvent(initialEvent);
    setServerBlockers(null);
  }

  const blockers = serverBlockers ?? publishBlockers(event);
  const minted = mintedTicketCount(event);
  const isPublished = event.status === "PUBLISHED";

  async function act(path: "publish" | "unpublish") {
    setPending(true);
    setError(null);
    setServerBlockers(null);

    const result = await requestJson<EventView>(`/api/events/${event.id}/${path}`, {
      method: "POST",
    });
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      if (result.code === "NOT_PUBLISHABLE") {
        // Trust the server's list over the one computed here.
        const details = result.details as { blockers?: PublishBlocker[] } | undefined;
        if (details?.blockers) setServerBlockers(details.blockers);
      }
      return;
    }
    setEvent(result.data);
    router.refresh();
  }

  return (
    <section
      aria-labelledby="publish-heading"
      className="rounded-card border border-border bg-surface-raised p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="publish-heading" className="text-lg font-semibold">
          Visibility
        </h2>
        <Badge tone={isPublished ? "positive" : "neutral"}>
          {isPublished ? "Published" : "Draft"}
        </Badge>
        {minted > 0 ? (
          <Badge tone="caution">
            {minted} ticket{minted === 1 ? "" : "s"} minted
          </Badge>
        ) : null}
      </div>

      <p className="mt-2 text-sm text-muted">
        {isPublished
          ? "This event is listed publicly and buyers can find it."
          : "Drafts are private. Nothing is listed publicly until you publish."}
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical"
        >
          {error}
        </p>
      ) : null}

      {!isPublished && blockers.length > 0 ? (
        <div className="mt-4 rounded-lg bg-caution-soft px-4 py-3 text-sm text-caution">
          <p className="font-semibold">Before you can publish:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
        {isPublished ? (
          <>
            <button
              type="button"
              onClick={() => act("unpublish")}
              disabled={pending || hasMintedTickets(event)}
              title={
                hasMintedTickets(event)
                  ? "Tickets are already on the ledger for this event"
                  : undefined
              }
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-50"
            >
              {pending ? "Working…" : "Return to draft"}
            </button>
            {hasMintedTickets(event) ? (
              <p className="text-sm text-muted">
                Tickets exist on the ledger, so this event stays public.
              </p>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            onClick={() => act("publish")}
            disabled={pending || blockers.length > 0}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Publishing…" : "Publish event"}
          </button>
        )}
      </div>
    </section>
  );
}
