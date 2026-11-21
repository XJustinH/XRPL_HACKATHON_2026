"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestJson } from "@/features/events/api-client";

/**
 * Follow / unfollow control for a seller (XRPL-061).
 *
 * The button is optimistic but reconciles: it flips immediately, then reverts
 * if the request fails, so a dead network cannot leave the UI claiming a follow
 * that was never saved.
 *
 * Duplicates are prevented on the server — following twice is a no-op there —
 * so a double click cannot create a second entry whatever this component does.
 */
export function FollowButton({
  sellerId,
  initialFollowing,
  sellerName,
}: {
  sellerId: string;
  initialFollowing: boolean;
  sellerName: string;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    const next = !following;
    setFollowing(next);
    setPending(true);
    setError(null);

    const result = await requestJson<{ following: boolean }>("/api/follows", {
      method: next ? "POST" : "DELETE",
      body: { sellerId },
    });
    setPending(false);

    if (!result.ok) {
      setFollowing(!next); // revert
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
        aria-pressed={following}
        className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
          following
            ? "border border-border hover:bg-surface"
            : "bg-accent text-accent-ink hover:opacity-90"
        }`}
      >
        {following ? "Following" : "Follow"}
        <span className="sr-only"> {sellerName}</span>
      </button>
      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
