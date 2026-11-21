"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/features/events/api-client";

/**
 * Save / unsave an event (XRPL-062).
 *
 * Optimistic but reconciling, like the follow button: it flips immediately and
 * reverts if the request fails. Repeated saves are a no-op server-side, so a
 * double click cannot duplicate whatever happens here.
 */
export function WishlistButton({
  eventId,
  initialSaved,
  eventTitle,
}: {
  eventId: string;
  initialSaved: boolean;
  eventTitle: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initialSaved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    const next = !saved;
    setSaved(next);
    setPending(true);
    setError(null);

    const result = await requestJson<{ saved: boolean }>("/api/wishlist", {
      method: next ? "POST" : "DELETE",
      body: { eventId },
    });
    setPending(false);

    if (!result.ok) {
      setSaved(!next);
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={saved}
        className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
          saved ? "border border-accent text-accent" : "border border-border hover:bg-surface"
        }`}
      >
        <span aria-hidden="true">{saved ? "★" : "☆"}</span>
        {saved ? "Saved" : "Save event"}
        <span className="sr-only"> {eventTitle}</span>
      </button>
      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
