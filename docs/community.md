# Community: posts, likes, comments, reports and notifications

Covers XRPL-080, XRPL-081, XRPL-082, XRPL-083 and XRPL-093. Code lives in `src/features/community/`,
contracts in `src/contracts/community.ts` (import that file directly; it is not in the contracts barrel yet).

## What each feature does

| Issue | Feature | In short |
|---|---|---|
| XRPL-080 | Seller posts | A seller or organiser publishes, edits and deletes text posts with an optional https image. They appear on the seller's public page. Customers cannot publish posts. |
| XRPL-081 | Likes | Any signed-in account can like a post once and unlike it. The count is read from the database on every read. The seller dashboard shows likes and comments per post and in total. |
| XRPL-082 | Comments | Signed-in accounts comment on a post and delete their own comments. The seller who owns the post can hide, show again or remove any comment on it. |
| XRPL-083 | Reports and moderation | A signed-in user reports a review, comment or post with a reason. A moderator hides the content or dismisses the report. Hidden content is not shown publicly. |
| XRPL-093 | Notifications | A user sees a notification for each new event (and post) from a seller they follow, can mark notifications read, and can turn them off. |

## Routes

All responses use the standard envelope. Every write needs a session and is same-origin only.

| Method and path | Who | What |
|---|---|---|
| `GET /api/sellers/:id/posts` | public | The seller's visible posts, newest first, with like and comment counts. |
| `GET /api/sellers/me/posts` | seller, organiser | Own posts, hidden ones included, with engagement totals. |
| `POST /api/sellers/me/posts` | seller, organiser | Publish `{ body, imageUrl? }`. 403 `ROLE_REQUIRED` for a customer. |
| `PATCH /api/posts/:id` | the post's seller | Edit `{ body?, imageUrl? }`. `imageUrl: ""` or `null` removes the image. |
| `DELETE /api/posts/:id` | the post's seller | Delete the post with its likes and comments. |
| `POST /api/posts/:id/likes` | signed in | Like. Idempotent. Returns `{ liked, likeCount }`. |
| `DELETE /api/posts/:id/likes` | signed in | Unlike. Idempotent. |
| `GET /api/posts/:id/comments` | public | Comments, oldest first. Hidden ones only for the post's seller and moderators. |
| `POST /api/posts/:id/comments` | signed in | Add `{ body }`. 429 `RATE_LIMITED` past the limit. |
| `DELETE /api/comments/:id` | the author, or the post's seller | Remove a comment. |
| `POST /api/comments/:id/hide` | the post's seller, or a moderator | `{ hidden?: boolean, reason? }`. Hides, or shows again with `hidden: false`. |
| `POST /api/reports` | signed in | `{ targetType: REVIEW, COMMENT or POST, targetId, reason, details? }`. |
| `GET /api/moderation/reports` | see "Who can moderate" | Open reports the caller may resolve. |
| `POST /api/moderation/reports/:id/resolve` | see "Who can moderate" | `{ action: HIDE or DISMISS, note? }`. |
| `GET /api/notifications/mine` | signed in | Inbox, unread count and opt-out state. Creates any notifications that are due. |
| `POST /api/notifications/:id/read` | the owner | Mark one read. |
| `POST /api/notifications/read-all` | signed in | Mark all read. |
| `PATCH /api/notifications/settings` | signed in | `{ optOut: boolean }`. |

Pages: `/seller/posts` (write, edit, delete, engagement totals), `/notifications` (inbox, read state,
opt-out switch), `/moderation` (open reports, hide or dismiss).

Components for other pages to mount:

- `SellerPostsFeed({ sellerId, viewer })` in `seller-posts-feed.tsx`: server component for the public
  seller page. Pass the session (or null) as `viewer`.
- `ReportButton({ targetType, targetId })` in `report-button.tsx`: already used in the review list
  (`src/features/reviews/event-reviews.tsx`) and under each comment and post.
- `countUnreadNotifications(db, userId)` in `notifications.ts`: for a badge on a nav link.

## Validation and content policy

Applied by the Zod schemas in `src/contracts/community.ts`, on the server, for every write.

- **Cleaning.** Text is normalised before it is checked or stored: line endings become `\n`, control
  characters are removed (tab and newline are kept), zero-width spaces, bidirectional overrides and
  the byte-order mark are removed, runs of three or more newlines collapse to two, and the ends are
  trimmed.
- **Plain text only.** Nothing is interpreted as markup. Text is stored as written and React escapes
  it when rendering; no component uses `dangerouslySetInnerHTML`.
- **Length.** Posts 1 to 2000 characters, comments 1 to 500, report details up to 500, moderation
  notes up to 200. The database repeats the post and comment limits as CHECK constraints.
- **Blocked words.** A short list of abusive terms is rejected with a 400. Matching is whole-word and
  case-insensitive, so a place name such as "Scunthorpe" passes. It is a first filter only; reports
  and moderation handle everything else.
- **Image link.** Optional. It must pass the shared `HttpUrl` check (no `javascript:`, `data:` and so
  on), start with `https://` and be at most 2048 characters. It is checked again with
  `safeExternalUrl` before it is rendered.

## Rate limits

Counted in the database at the time of the write, per account, so extra tabs do not raise them.
Past the limit the API answers 429 `RATE_LIMITED`.

| What | Limit |
|---|---|
| Comments | 5 a minute, across all posts |
| Posts | 10 an hour |
| Reports | 20 an hour, and one per account per item |

## Who can moderate

There is no admin role in the schema, so:

- **Site moderators** are the account ids listed in the server-only env var `MODERATOR_USER_IDS`
  (comma-separated `User.id` values). They can resolve any report and hide any comment.
- **A seller** can hide, show again and remove comments on their own posts, and can resolve reports
  about other people's comments on their posts and other people's reviews of their events.
- A seller cannot resolve a report about their own content (their own post, or a comment or review
  they wrote), and cannot show again a comment that a site moderator hid.

Hiding sets `hiddenAt`, `hiddenById` and `hiddenReason` on that one row. Nothing is deleted, so the
author's other content is untouched and the decision can be audited. Hiding also closes every open
report about the same item. Hidden posts, comments and reviews are left out of every public read and
out of the public counts and the review average.

## How notifications are generated and deduplicated

There is no background job and the event-publishing code is not involved. When the inbox is read
(`GET /api/notifications/mine`, the `/notifications` page or `countUnreadNotifications`), the server:

1. reads the sellers the user follows from the follows service (`listFollowedSellerIds`);
2. finds each seller's published, upcoming events with `publishedAt` on or after the follow date, and
   each seller's visible posts written on or after it;
3. inserts one `Notification` row per event and per post with `ON CONFLICT DO NOTHING`.

`Notification` has a unique index on `(userId, eventId)` and on `(userId, postId)`, so reading the
inbox again, or from two tabs at once, cannot create a duplicate or reset a notification that was
read. A notification is dated when the event was published, not when the inbox was opened.

**Opt-out.** These are optional notifications. The switch is stored in `User.settings` under
`notifications: { optOut, resumedAt }`, beside the other preferences. While opted out, nothing new is
created; what is already in the inbox stays. Opting back in records the time, and only things
published after it are notified.

## Limitations

- **Follow dates.** The follows service still keeps follows as a list in `User.settings`, which has no
  date. The follow date is taken from the `Follow` table when a row exists for the pair. When it does
  not, events and posts from the previous 30 days count as "since the follow", so someone who just
  followed a seller may see notifications for things announced shortly before. This becomes exact
  once the follows service writes `Follow` rows.
- Notifications appear when the inbox is next read, not at the moment of publishing, and are in-app
  only (no email or push).
- Rate limits are a count followed by an insert, so two requests racing at the limit can both pass.
- The blocked-word list is small and English-only.
- Sellers moderate reviews of their own events, as specified. That lets a seller hide a critical
  review; the hide is recorded (`hiddenById`, `hiddenReason`) but nobody reviews it. Restricting
  review moderation to site moderators is a one-line change in `canResolve` (`reports.ts`).
- There is no page to undo a hide on a review or a post; a comment can be shown again by whoever hid
  it or by a moderator.
- Lists are capped rather than paginated: 20 posts on a seller's page, 100 comments per post, 50
  notifications, 200 open reports.
- Image links are hot-linked from the seller's chosen host; nothing is uploaded or proxied.
