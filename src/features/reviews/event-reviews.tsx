"use client";

/**
 * Reviews section for an event page (XRPL-079). Agent C can place <EventReviews eventId /> on
 * the event detail page. Only verified attendees see the form; the server enforces it too.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type EventReviews as EventReviewsData, REVIEW_BODY_MAX, type ReviewView } from "@/contracts/reviews";
import { ReportButton } from "@/features/community/report-button";

type Load = { kind: "loading" } | { kind: "ready"; data: EventReviewsData } | { kind: "error"; message: string };

async function send(url: string, method: "GET" | "POST" | "PATCH", body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
    if (res.ok && json && "data" in json) return { ok: true as const, data: json.data };
    return { ok: false as const, message: json?.error?.message ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false as const, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

export function EventReviews({ eventId }: { eventId: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const res = await send(`/api/events/${eventId}/reviews`, "GET");
    setLoad(res.ok ? { kind: "ready", data: res.data as EventReviewsData } : { kind: "error", message: res.message });
  }, [eventId]);

  useEffect(() => {
    let live = true;
    void send(`/api/events/${eventId}/reviews`, "GET").then((res) => {
      if (live) setLoad(res.ok ? { kind: "ready", data: res.data as EventReviewsData } : { kind: "error", message: res.message });
    });
    return () => {
      live = false;
    };
  }, [eventId]);

  return (
    <section aria-labelledby="reviews-heading" className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id="reviews-heading" className="text-lg font-semibold">
        Reviews
      </h2>
      {load.kind === "loading" ? <p className="mt-2 text-sm text-muted">Loading reviews…</p> : null}
      {load.kind === "error" ? <p className="mt-2 text-sm text-muted">{load.message}</p> : null}
      {load.kind === "ready" ? <ReviewsBody data={load.data} eventId={eventId} onSaved={refresh} /> : null}
    </section>
  );
}

function ReviewsBody({ data, eventId, onSaved }: { data: EventReviewsData; eventId: string; onSaved: () => Promise<void> }) {
  const viewer = data.viewer;
  const own = viewer.status === "ALREADY_REVIEWED" ? data.reviews.find((r) => r.id === viewer.reviewId) : undefined;
  return (
    <>
      <p className="mt-1 text-sm text-muted">
        {data.count === 0
          ? "Only people who were checked in at this event can review it."
          : `${data.averageRating} out of 5 from ${data.count} ${data.count === 1 ? "attendee" : "attendees"}.`}
      </p>

      <div className="mt-4">
        {data.viewer.status === "CAN_REVIEW" ? <ReviewForm eventId={eventId} onSaved={onSaved} /> : null}
        {data.viewer.status === "ALREADY_REVIEWED" && own ? <ReviewForm eventId={eventId} existing={own} onSaved={onSaved} /> : null}
        {data.viewer.status === "ALREADY_REVIEWED" && !own ? (
          <p className="text-sm text-muted">Your review has been hidden by moderation.</p>
        ) : null}
        {data.viewer.status === "NOT_ATTENDED" ? (
          <p className="text-sm text-muted">You can review this event once you&apos;ve been checked in at the door.</p>
        ) : null}
        {data.viewer.status === "NOT_SIGNED_IN" ? (
          <p className="text-sm text-muted">
            <Link href="/onboarding" className="font-semibold text-accent underline-offset-2 hover:underline">
              Sign in
            </Link>{" "}
            to review an event you attended.
          </p>
        ) : null}
      </div>

      {data.reviews.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted">No reviews yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border" aria-label="Reviews">
          {data.reviews.map((r) => (
            // Signed-in viewers can report someone else's review (XRPL-083); the server checks again.
            <ReviewItem key={r.id} review={r} canReport={viewer.status !== "NOT_SIGNED_IN" && r.id !== own?.id} />
          ))}
        </ul>
      )}
    </>
  );
}

function ReviewItem({ review, canReport }: { review: ReviewView; canReport: boolean }) {
  return (
    <li className="py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold">{review.author.displayName}</span>
        <Stars value={review.rating} />
        <span className="text-muted">
          {new Date(review.createdAt).toLocaleDateString()}
          {review.editedAt ? " · edited" : ""}
        </span>
      </p>
      {review.body ? <p className="mt-1 whitespace-pre-line text-sm">{review.body}</p> : null}
      {canReport ? <ReportButton targetType="REVIEW" targetId={review.id} /> : null}
    </li>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span role="img" aria-label={`${value} out of 5`} className="tracking-tight">
      {"★".repeat(value)}
      <span className="text-muted">{"★".repeat(5 - value)}</span>
    </span>
  );
}

function ReviewForm({ eventId, existing, onSaved }: { eventId: string; existing?: ReviewView; onSaved: () => Promise<void> }) {
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [body, setBody] = useState(existing?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) return setMessage({ tone: "error", text: "Choose a rating from 1 to 5 stars." });
    setSaving(true);
    setMessage(null);
    const res = existing
      ? await send(`/api/events/${eventId}/reviews/mine`, "PATCH", { rating, body })
      : await send(`/api/events/${eventId}/reviews`, "POST", { rating, body });
    setSaving(false);
    if (!res.ok) return setMessage({ tone: "error", text: res.message });
    setMessage({ tone: "ok", text: existing ? "Review updated." : "Thanks for your review." });
    await onSaved();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" aria-label={existing ? "Edit your review" : "Write a review"}>
      <fieldset>
        <legend className="text-sm font-semibold">{existing ? "Edit your review" : "Your rating"}</legend>
        <div className="mt-1 flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="cursor-pointer">
              <input
                type="radio"
                name={`rating-${eventId}`}
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                className="peer sr-only"
                aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
              />
              <span
                aria-hidden="true"
                className={`flex min-h-11 min-w-11 items-center justify-center rounded-lg text-2xl peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
                  n <= rating ? "" : "text-muted"
                }`}
              >
                ★
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`review-body-${eventId}`}>Comments (optional)</label>
        <textarea
          id={`review-body-${eventId}`}
          aria-describedby={`review-count-${eventId}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={REVIEW_BODY_MAX}
          rows={3}
          className="rounded-lg border border-border bg-canvas px-3 py-2"
        />
        <span id={`review-count-${eventId}`} className="text-xs text-muted tabular-nums">
          {body.length}/{REVIEW_BODY_MAX} characters
        </span>
      </div>
      <button
        type="submit"
        disabled={saving}
        className="min-h-11 self-start rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
      >
        {saving ? "Saving…" : existing ? "Update review" : "Post review"}
      </button>
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-critical" : "text-positive"}`}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
