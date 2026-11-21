import { safeExternalUrl } from "@/contracts/common";
import type { CommentView, SellerPostView } from "@/contracts/community";
import { getDb } from "@/lib/db/client";
import type { CommunityViewer } from "./access";
import { formatDate } from "./client";
import { listCommentsForPosts } from "./comments";
import { LikeButton } from "./like-button";
import { PostComments } from "./post-comments";
import { listSellerPosts } from "./posts";
import { ReportButton } from "./report-button";

/**
 * A seller's public posts with likes and comments (XRPL-080 to XRPL-082). Server component.
 *
 * Self-contained: give it the seller's id and the current session (or null) and it loads and
 * renders everything. Mount it on the public seller page:
 *
 *   <SellerPostsFeed sellerId={id} viewer={session} />
 *
 * Hidden posts and hidden comments are left out for the public. A failure to load shows a notice
 * here instead of breaking the page around it.
 */
export async function SellerPostsFeed({ sellerId, viewer }: { sellerId: string; viewer: CommunityViewer }) {
  const viewerId = viewer?.userId ?? null;
  let posts: SellerPostView[];
  let comments: Map<string, CommentView[]>;
  try {
    const db = getDb();
    posts = await listSellerPosts(db, sellerId, viewerId);
    comments = await listCommentsForPosts(
      db,
      posts.map((post) => post.id),
      viewerId,
    );
  } catch (error) {
    console.error("[community] could not load a seller's posts", error);
    return (
      <section aria-labelledby="posts-heading">
        <h2 id="posts-heading" className="mb-4 text-lg font-semibold">
          Posts
        </h2>
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Posts could not be loaded. Refresh to try again.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="posts-heading">
      <h2 id="posts-heading" className="mb-4 text-lg font-semibold">
        Posts
      </h2>
      {posts.length === 0 ? (
        <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
          No posts yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {posts.map((post) => (
            <li key={post.id}>
              <PostCard post={post} comments={comments.get(post.id) ?? []} viewerId={viewerId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PostCard({
  post,
  comments,
  viewerId,
}: {
  post: SellerPostView;
  comments: CommentView[];
  viewerId: string | null;
}) {
  // Checked again here: a stored link is never passed straight to a src.
  const imageUrl = safeExternalUrl(post.imageUrl);
  return (
    <article className="rounded-card border border-border bg-surface-raised p-5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-semibold">{post.seller.displayName}</span>
        <span className="text-muted">
          {formatDate(post.createdAt)}
          {post.editedAt ? " · edited" : ""}
        </span>
      </p>
      <p className="mt-2 whitespace-pre-line break-words text-sm">{post.body}</p>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="mt-3 max-h-96 w-full rounded-lg object-cover"
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <LikeButton
          postId={post.id}
          initialLiked={post.likedByViewer}
          initialCount={post.likeCount}
          signedIn={viewerId !== null}
        />
        {viewerId && viewerId !== post.seller.id ? <ReportButton targetType="POST" targetId={post.id} /> : null}
      </div>
      <PostComments postId={post.id} initialComments={comments} viewerId={viewerId} />
    </article>
  );
}
