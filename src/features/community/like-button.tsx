"use client";

import Link from "next/link";
import { useState } from "react";
import type { LikeState } from "@/contracts/community";
import { requestJson } from "@/features/events/api-client";

/**
 * Like / unlike control for a seller post (XRPL-081).
 *
 * The count shown after a click is the one the server returns, read from the database, so it
 * matches what a refresh would show. One like per account is enforced by the server, so a double
 * click cannot count twice whatever this component does.
 */
export function LikeButton({
  postId,
  initialLiked,
  initialCount,
  signedIn,
}: {
  postId: string;
  initialLiked: boolean;
  initialCount: number;
  signedIn: boolean;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await requestJson<LikeState>(`/api/posts/${postId}/likes`, {
      method: liked ? "DELETE" : "POST",
    });
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setLiked(result.data.liked);
    setCount(result.data.likeCount);
  }

  const label = `${count} ${count === 1 ? "like" : "likes"}`;

  if (!signedIn) {
    return (
      <p className="flex min-h-11 items-center gap-2 text-sm text-muted">
        <span>♥ {label}</span>
        <Link href="/onboarding" className="font-medium text-accent underline-offset-2 hover:underline">
          Sign in to like
        </Link>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={liked}
        className={`min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${
          liked ? "bg-accent-soft text-accent" : "border border-border hover:bg-surface"
        }`}
      >
        <span aria-hidden="true">{liked ? "♥" : "♡"} </span>
        {liked ? "Liked" : "Like"}
        <span className="sr-only"> this post</span>
      </button>
      <span className="text-sm text-muted tabular-nums">{label}</span>
      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
