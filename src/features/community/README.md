# src/features/community — Agent E

Seller posts, likes, comments, reports and moderation, and notifications (XRPL-080 to XRPL-083,
XRPL-093). Contracts in `src/contracts/community.ts`. Full write-up: `docs/community.md`.
Spotify (XRPL-092) is not built.

| File | What it holds |
|---|---|
| `access.ts` | `CommunityViewer`, `isSellerRole`, `isModerator` (env `MODERATOR_USER_IDS`), the 429 helper |
| `posts.ts` | create, edit, delete and list seller posts; the seller dashboard with engagement totals |
| `likes.ts` | like and unlike; one per account, count read from the database |
| `comments.ts` | add (rate-limited), list, delete, hide |
| `reports.ts` | report a review, comment or post; the queue; hide or dismiss |
| `notifications.ts` | lazy generation, inbox, read state, opt-out |
| `route-helpers.ts` | `idParam` for `:id` segments |
| `seller-posts-feed.tsx` | `SellerPostsFeed`: server component for the public seller page |
| `like-button.tsx`, `post-comments.tsx`, `report-button.tsx` | client controls used by the feed (and `ReportButton` by the review list) |
| `seller-posts-manager.tsx`, `notifications-inbox.tsx`, `moderation-queue.tsx` | client parts of `/seller/posts`, `/notifications`, `/moderation` |
| `community.int.test.ts` | database tests for all five issues |

Rules worth knowing before changing anything:

- Roles and ownership are checked in the service functions, not only in the routes or the UI.
- Hiding never deletes: it sets `hiddenAt`, `hiddenById` and `hiddenReason`. Public reads filter on `hiddenAt`.
- Notifications are created when the inbox is read and deduplicated by unique indexes.
