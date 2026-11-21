"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { COMMENT_BODY_MAX, type CommentView } from "@/contracts/community";
import { Badge } from "@/components/ui/badge";
import { requestJson } from "@/features/events/api-client";
import { failureMessage, formatDate, linkButton } from "./client";
import { ReportButton } from "./report-button";

/**
 * Comments under a seller post (XRPL-082): the list, the form, and the controls each viewer is
 * allowed (delete your own; the post's seller can hide or remove; anyone signed in can report).
 *
 * The flags on each comment come from the server and only decide which buttons are drawn. Every
 * action is checked again by the API. Comment text is rendered as plain text.
 */
export function PostComments({
  postId,
  initialComments,
  viewerId,
}: {
  postId: string;
  initialComments: CommentView[];
  /** Null when signed out. */
  viewerId: string | null;
}) {
  const id = useId();
  const [comments, setComments] = useState(initialComments);
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || body.trim() === "") return;
    setPending(true);
    setError(null);
    const result = await requestJson<CommentView>(`/api/posts/${postId}/comments`, {
      method: "POST",
      body: { body },
    });
    setPending(false);
    if (!result.ok) {
      setError(failureMessage(result));
      return;
    }
    setComments((current) => [...current, result.data]);
    setBody("");
  }

  async function remove(commentId: string) {
    setError(null);
    const result = await requestJson<{ id: string }>(`/api/comments/${commentId}`, { method: "DELETE" });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setComments((current) => current.filter((comment) => comment.id !== commentId));
  }

  async function setHidden(commentId: string, hidden: boolean) {
    setError(null);
    const result = await requestJson<CommentView>(`/api/comments/${commentId}/hide`, {
      method: "POST",
      body: { hidden },
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setComments((current) => current.map((comment) => (comment.id === commentId ? result.data : comment)));
  }

  const visibleCount = comments.filter((comment) => !comment.hidden).length;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <h4 className="text-sm font-semibold">
        {visibleCount} {visibleCount === 1 ? "comment" : "comments"}
      </h4>

      {comments.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-3" aria-label="Comments">
          {comments.map((comment) => (
            <li key={comment.id} className="text-sm">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{comment.author.displayName}</span>
                <span className="text-muted">{formatDate(comment.createdAt)}</span>
                {comment.hidden ? <Badge tone="caution">Hidden</Badge> : null}
              </p>
              <p className={`mt-0.5 whitespace-pre-line break-words ${comment.hidden ? "text-muted" : ""}`}>
                {comment.body}
              </p>
              <div className="flex flex-wrap items-start gap-x-4">
                {comment.canDelete ? (
                  <button type="button" onClick={() => remove(comment.id)} className={linkButton}>
                    Delete
                  </button>
                ) : null}
                {comment.canHide ? (
                  <button type="button" onClick={() => setHidden(comment.id, !comment.hidden)} className={linkButton}>
                    {comment.hidden ? "Show again" : "Hide"}
                  </button>
                ) : null}
                {viewerId && comment.author.id !== viewerId && !comment.hidden ? (
                  <ReportButton targetType="COMMENT" targetId={comment.id} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {viewerId ? (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2" aria-label="Add a comment">
          <label htmlFor={`${id}-comment`} className="sr-only">
            Add a comment
          </label>
          <textarea
            id={`${id}-comment`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={COMMENT_BODY_MAX}
            rows={2}
            placeholder="Add a comment"
            className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending || body.trim() === ""}
              className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
            >
              {pending ? "Posting…" : "Comment"}
            </button>
            <span className="text-xs text-muted tabular-nums">
              {body.length}/{COMMENT_BODY_MAX}
            </span>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-sm text-muted">
          <Link href="/onboarding" className="font-medium text-accent underline-offset-2 hover:underline">
            Sign in
          </Link>{" "}
          to comment.
        </p>
      )}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
