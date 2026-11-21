/**
 * Agent E contract slice: seller posts, likes, comments, reports and notifications
 * (XRPL-080 to XRPL-083, XRPL-093). Import from "@/contracts/community" directly.
 * Safe to import from both server and client code.
 */
import { z } from "zod";
import { AppId, HttpUrl, type IsoDateTime } from "./common";

// ---------------------------------------------------------------------------
// Text policy (XRPL-080, XRPL-082)
// ---------------------------------------------------------------------------

export const POST_BODY_MAX = 2000;
export const COMMENT_BODY_MAX = 500;
export const REPORT_DETAILS_MAX = 500;
export const MODERATION_NOTE_MAX = 200;
export const IMAGE_URL_MAX = 2048;

/** Rate limits. Each is counted in the database when the write is made. */
export const POSTS_PER_HOUR = 10;
export const COMMENTS_PER_MINUTE = 5;
export const REPORTS_PER_HOUR = 20;

/**
 * Control characters (other than tab and newline), plus the invisible characters used to hide or
 * reorder text: zero-width space, bidirectional overrides and isolates, and the byte-order mark.
 * The zero-width joiner is kept because emoji sequences need it.
 */
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‪-‮⁦-⁩﻿]/g;

/**
 * Normalises user text before it is validated and stored: plain text only. Unsafe characters are
 * removed, line endings become "\n", runs of blank lines collapse, and the ends are trimmed.
 * Nothing here escapes HTML: the text is stored as written and React escapes it on render.
 */
export function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A deliberately small list. It catches the obvious cases; reports and moderation handle the rest. */
const BLOCKED_WORDS = ["fuck", "shit", "bitch", "cunt", "asshole", "wanker", "nigger", "faggot", "retard", "kill yourself", "kys"];

const BLOCKED_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${BLOCKED_WORDS.map((word) => word.replace(/ /g, "\\s+")).join("|")})(?:s|es|ed|er|ers|ing|y)?(?![\\p{L}\\p{N}])`,
  "iu",
);

/** Whole-word match, ignoring case and zero-width joiners, so "Scunthorpe" is not a false hit. */
export function containsBlockedWords(value: string): boolean {
  return BLOCKED_PATTERN.test(value.normalize("NFKC").replace(/[‌‍]/g, ""));
}

const policyText = (max: number, label: string) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, `${label} can't be empty`)
        .max(max, `${label} can be at most ${max} characters`)
        .refine((value) => !containsBlockedWords(value), "This contains language that isn't allowed here"),
    );

// ---------------------------------------------------------------------------
// Seller posts (XRPL-080)
// ---------------------------------------------------------------------------

/** An https image link. `HttpUrl` already rules out javascript:, data: and the like. */
export const PostImageUrl = HttpUrl.refine(
  (value) => /^https:\/\//i.test(value) && value.length <= IMAGE_URL_MAX,
  "Image links must start with https://",
);

/** A link, or "" / null meaning "no image". */
const PostImageField = z.union([PostImageUrl, z.literal(""), z.null()]).transform((value) => value || null);

export const PostBody = policyText(POST_BODY_MAX, "A post");

/** Body of POST /api/sellers/me/posts. */
export const SellerPostInput = z.object({
  body: PostBody,
  imageUrl: PostImageField.optional(),
});
export type SellerPostInput = z.infer<typeof SellerPostInput>;

/** Body of PATCH /api/posts/:id. An omitted field is left as it is. */
export const SellerPostPatch = z
  .object({ body: PostBody.optional(), imageUrl: PostImageField.optional() })
  .refine((value) => value.body !== undefined || value.imageUrl !== undefined, "Nothing to change");
export type SellerPostPatch = z.infer<typeof SellerPostPatch>;

export type CommunityAuthor = { id: string; displayName: string };

export type SellerPostView = {
  id: string;
  seller: CommunityAuthor;
  body: string;
  imageUrl: string | null;
  createdAt: IsoDateTime;
  /** Set when the seller edited it after posting. */
  editedAt: IsoDateTime | null;
  /** Counted in the database on every read (XRPL-081). */
  likeCount: number;
  /** Visible comments only. */
  commentCount: number;
  /** False for a signed-out viewer. */
  likedByViewer: boolean;
  /** Hidden by moderation. Only the seller's own dashboard ever returns a hidden post. */
  hidden: boolean;
};

/** GET /api/sellers/:id/posts */
export type SellerPostsFeedData = { sellerId: string; posts: SellerPostView[] };

/** GET /api/sellers/me/posts: the seller's own posts with engagement totals (XRPL-081). */
export type SellerPostsDashboard = {
  posts: SellerPostView[];
  totals: { posts: number; likes: number; comments: number };
};

// ---------------------------------------------------------------------------
// Likes (XRPL-081)
// ---------------------------------------------------------------------------

/** Response of POST and DELETE /api/posts/:id/likes. */
export type LikeState = { postId: string; liked: boolean; likeCount: number };

// ---------------------------------------------------------------------------
// Comments (XRPL-082)
// ---------------------------------------------------------------------------

/** Body of POST /api/posts/:id/comments. */
export const CommentInput = z.object({ body: policyText(COMMENT_BODY_MAX, "A comment") });
export type CommentInput = z.infer<typeof CommentInput>;

export type CommentView = {
  id: string;
  postId: string;
  author: CommunityAuthor;
  body: string;
  createdAt: IsoDateTime;
  /** Hidden comments are only returned to the post's seller and to moderators. */
  hidden: boolean;
  /** The viewer wrote it, or owns the post it is on. */
  canDelete: boolean;
  /** The viewer owns the post it is on, or is a moderator. */
  canHide: boolean;
};

/** GET /api/posts/:id/comments */
export type PostCommentsData = { postId: string; comments: CommentView[] };

/** Body of POST /api/comments/:id/hide. `hidden: false` shows the comment again. */
export const HideCommentInput = z.object({
  hidden: z.boolean().default(true),
  reason: z.string().trim().max(MODERATION_NOTE_MAX).optional(),
});

// ---------------------------------------------------------------------------
// Reports and moderation (XRPL-083)
// ---------------------------------------------------------------------------

export const REPORT_TARGET_TYPES = ["REVIEW", "COMMENT", "POST"] as const;
export const ReportTargetType = z.enum(REPORT_TARGET_TYPES);
export type ReportTargetType = z.infer<typeof ReportTargetType>;

export const REPORT_REASONS = ["SPAM", "ABUSE", "HARASSMENT", "MISLEADING", "OTHER"] as const;
export const ReportReason = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReason>;

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SPAM: "Spam or advertising",
  ABUSE: "Abusive or hateful",
  HARASSMENT: "Harassment",
  MISLEADING: "False or misleading",
  OTHER: "Something else",
};

/** Body of POST /api/reports. */
export const ReportInput = z.object({
  targetType: ReportTargetType,
  targetId: AppId,
  reason: ReportReason,
  details: z.string().transform(cleanText).pipe(z.string().max(REPORT_DETAILS_MAX)).default(""),
});
export type ReportInput = z.infer<typeof ReportInput>;

export type ReportStatus = "OPEN" | "ACTIONED" | "DISMISSED";

export type ReportView = {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: ReportReason | string;
  details: string;
  status: ReportStatus;
  createdAt: IsoDateTime;
  reporter: CommunityAuthor;
  /** What was reported, or null if it has since been deleted. */
  target: {
    author: CommunityAuthor;
    excerpt: string;
    /** For example "Review of Summer Gig" or "Comment on a post by Venue". */
    context: string;
    hidden: boolean;
  } | null;
};

/** GET /api/moderation/reports */
export type ModerationQueue = { reports: ReportView[] };

/** Body of POST /api/moderation/reports/:id/resolve. */
export const ResolveReportInput = z.object({
  action: z.enum(["HIDE", "DISMISS"]),
  note: z.string().trim().max(MODERATION_NOTE_MAX).optional(),
});
export type ResolveReportInput = z.infer<typeof ResolveReportInput>;

// ---------------------------------------------------------------------------
// Notifications (XRPL-093)
// ---------------------------------------------------------------------------

export type NotificationView = {
  id: string;
  kind: "NEW_EVENT" | "NEW_POST";
  /** When the event was published or the post written. */
  createdAt: IsoDateTime;
  readAt: IsoDateTime | null;
  seller: CommunityAuthor;
  /** The event title, or the start of the post. */
  title: string;
  /** Where the notification leads: the event page or the seller's page. */
  href: string;
};

/** GET /api/notifications/mine */
export type NotificationInbox = {
  items: NotificationView[];
  unreadCount: number;
  /** True when the user has turned optional notifications off: no new ones are created. */
  optedOut: boolean;
};

/** Body of PATCH /api/notifications/settings. */
export const NotificationSettingsInput = z.object({ optOut: z.boolean() });
