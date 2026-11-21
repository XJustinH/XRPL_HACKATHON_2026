"use client";

import { useState } from "react";
import {
  POST_BODY_MAX,
  type SellerPostView,
  type SellerPostsDashboard,
} from "@/contracts/community";
import { Badge } from "@/components/ui/badge";
import { requestJson } from "@/features/events/api-client";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { failureMessage, formatDate } from "./client";

/**
 * The seller's posts dashboard (XRPL-080, XRPL-081): write a post, edit or delete one, and see
 * likes and comments per post and in total. The numbers come from the server; after a change
 * here they are adjusted locally and a refresh reads them from the database again.
 */
export function SellerPostsManager({ initial }: { initial: SellerPostsDashboard }) {
  const [posts, setPosts] = useState(initial.posts);
  const [totals, setTotals] = useState(initial.totals);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(post: SellerPostView) {
    if (!window.confirm("Delete this post? Its likes and comments are deleted too.")) return;
    setError(null);
    const result = await requestJson<{ id: string }>(`/api/posts/${post.id}`, { method: "DELETE" });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPosts((current) => current.filter((item) => item.id !== post.id));
    setTotals((current) => ({
      posts: current.posts - 1,
      likes: current.likes - post.likeCount,
      comments: current.comments - post.commentCount,
    }));
  }

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-3 gap-3" aria-label="Engagement totals">
        {(
          [
            ["Posts", totals.posts],
            ["Likes", totals.likes],
            ["Comments", totals.comments],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className={card}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="compose-heading" className={card}>
        <h2 id="compose-heading" className="text-lg font-semibold">
          New post
        </h2>
        <PostForm
          submitLabel="Publish"
          onSaved={(post) => {
            setPosts((current) => [post, ...current]);
            setTotals((current) => ({ ...current, posts: current.posts + 1 }));
          }}
        />
      </section>

      <section aria-labelledby="your-posts-heading">
        <h2 id="your-posts-heading" className="mb-3 text-lg font-semibold">
          Your posts
        </h2>
        {error ? (
          <p role="alert" className={`mb-3 ${notice.critical}`}>
            {error}
          </p>
        ) : null}
        {posts.length === 0 ? (
          <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
            You have not posted anything yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {posts.map((post) => (
              <li key={post.id} className={card}>
                {editingId === post.id ? (
                  <PostForm
                    existing={post}
                    submitLabel="Save changes"
                    onCancel={() => setEditingId(null)}
                    onSaved={(saved) => {
                      setPosts((current) => current.map((item) => (item.id === saved.id ? saved : item)));
                      setEditingId(null);
                    }}
                  />
                ) : (
                  <>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                      <span>
                        {formatDate(post.createdAt)}
                        {post.editedAt ? " · edited" : ""}
                      </span>
                      {post.hidden ? <Badge tone="caution">Hidden by moderation</Badge> : null}
                    </p>
                    <p className="mt-2 whitespace-pre-line break-words text-sm">{post.body}</p>
                    {post.imageUrl ? (
                      <p className="mt-2 break-all text-sm text-muted">Image: {post.imageUrl}</p>
                    ) : null}
                    <p className="mt-3 text-sm tabular-nums">
                      {post.likeCount} {post.likeCount === 1 ? "like" : "likes"} · {post.commentCount}{" "}
                      {post.commentCount === 1 ? "comment" : "comments"}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => setEditingId(post.id)} className={`min-h-11 ${secondaryButton}`}>
                        Edit
                      </button>
                      <button type="button" onClick={() => remove(post)} className={`min-h-11 ${secondaryButton}`}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PostForm({
  existing,
  submitLabel,
  onSaved,
  onCancel,
}: {
  existing?: SellerPostView;
  submitLabel: string;
  onSaved: (post: SellerPostView) => void;
  onCancel?: () => void;
}) {
  const fieldId = existing?.id ?? "new";
  const [body, setBody] = useState(existing?.body ?? "");
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const payload = { body, imageUrl: imageUrl.trim() };
    const result = existing
      ? await requestJson<SellerPostView>(`/api/posts/${existing.id}`, { method: "PATCH", body: payload })
      : await requestJson<SellerPostView>("/api/sellers/me/posts", { method: "POST", body: payload });
    setPending(false);
    if (!result.ok) {
      setError(failureMessage(result));
      return;
    }
    if (!existing) {
      setBody("");
      setImageUrl("");
    }
    onSaved(result.data);
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3" aria-label={existing ? "Edit post" : "New post"}>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`post-body-${fieldId}`}>What do you want to tell your followers?</label>
        <textarea
          id={`post-body-${fieldId}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={POST_BODY_MAX}
          rows={4}
          required
          className="rounded-lg border border-border bg-canvas px-3 py-2"
        />
        <span className="text-xs text-muted tabular-nums">
          {body.length}/{POST_BODY_MAX} characters
        </span>
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor={`post-image-${fieldId}`}>Image link (optional, https)</label>
        <input
          id={`post-image-${fieldId}`}
          type="url"
          inputMode="url"
          value={imageUrl}
          onChange={(event) => setImageUrl(event.target.value)}
          placeholder="https://"
          className="min-h-11 rounded-lg border border-border bg-canvas px-3"
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || body.trim() === ""} className={`min-h-11 ${primaryButton}`}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className={`min-h-11 ${secondaryButton}`}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={notice.critical}>
          {error}
        </p>
      ) : null}
    </form>
  );
}
