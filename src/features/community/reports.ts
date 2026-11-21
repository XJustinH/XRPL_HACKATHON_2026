import type { PrismaClient } from "@/generated/prisma/client";
import {
  REPORTS_PER_HOUR,
  type ReportInput,
  type ReportStatus,
  type ReportTargetType,
  type ReportView,
  type ResolveReportInput,
} from "@/contracts/community";
import { errors } from "@/lib/http/response";
import { excerpt, isModerator, rateLimited } from "./access";

/**
 * Reports and moderation (XRPL-083).
 *
 * Any signed-in user can report a review, a comment or a post, once per item. Resolving a report
 * either hides the content or dismisses the report. Hiding sets `hiddenAt` (with who and why) on
 * that one row: nothing is deleted, so the author's other content and the row itself survive and
 * the decision can be audited.
 *
 * Who may resolve:
 *  - site moderators (MODERATOR_USER_IDS): everything;
 *  - a seller: reports about other people's comments on their own posts and other people's
 *    reviews of their own events. Never reports about their own content.
 */

type Db = PrismaClient;

const HOUR_MS = 60 * 60 * 1000;
const QUEUE_LIMIT = 200;

type TargetRef = { targetType: ReportTargetType; targetId: string };

type Target = {
  author: { id: string; displayName: string };
  text: string;
  context: string;
  hidden: boolean;
  /** The seller who may moderate it besides site moderators, or null if only moderators may. */
  ownerId: string | null;
};

const keyOf = (ref: TargetRef) => `${ref.targetType}:${ref.targetId}`;

async function loadTargets(db: Db, refs: TargetRef[]): Promise<Map<string, Target>> {
  const ids = (type: ReportTargetType) => refs.filter((ref) => ref.targetType === type).map((ref) => ref.targetId);
  const [reviewIds, commentIds, postIds] = [ids("REVIEW"), ids("COMMENT"), ids("POST")];
  const author = { select: { displayName: true } };

  const [reviews, comments, posts] = await Promise.all([
    reviewIds.length === 0
      ? []
      : db.review.findMany({
          where: { id: { in: reviewIds } },
          select: {
            id: true,
            authorId: true,
            rating: true,
            body: true,
            hiddenAt: true,
            author,
            event: { select: { title: true, sellerId: true } },
          },
        }),
    commentIds.length === 0
      ? []
      : db.postComment.findMany({
          where: { id: { in: commentIds } },
          select: {
            id: true,
            authorId: true,
            body: true,
            hiddenAt: true,
            author,
            post: { select: { sellerId: true, seller: author } },
          },
        }),
    postIds.length === 0
      ? []
      : db.sellerPost.findMany({
          where: { id: { in: postIds } },
          select: { id: true, sellerId: true, body: true, hiddenAt: true, seller: author },
        }),
  ]);

  const targets = new Map<string, Target>();
  for (const review of reviews) {
    targets.set(keyOf({ targetType: "REVIEW", targetId: review.id }), {
      author: { id: review.authorId, displayName: review.author.displayName },
      text: `${review.rating}/5${review.body ? `: ${review.body}` : ""}`,
      context: `Review of ${review.event.title}`,
      hidden: review.hiddenAt !== null,
      ownerId: review.event.sellerId,
    });
  }
  for (const comment of comments) {
    targets.set(keyOf({ targetType: "COMMENT", targetId: comment.id }), {
      author: { id: comment.authorId, displayName: comment.author.displayName },
      text: comment.body,
      context: `Comment on a post by ${comment.post.seller.displayName}`,
      hidden: comment.hiddenAt !== null,
      ownerId: comment.post.sellerId,
    });
  }
  for (const post of posts) {
    targets.set(keyOf({ targetType: "POST", targetId: post.id }), {
      author: { id: post.sellerId, displayName: post.seller.displayName },
      text: post.body,
      context: `Post by ${post.seller.displayName}`,
      hidden: post.hiddenAt !== null,
      ownerId: null,
    });
  }
  return targets;
}

/** Moderators always; a seller for content on their own post or event that someone else wrote. */
function canResolve(actorId: string, target: Target | undefined): boolean {
  if (isModerator(actorId)) return true;
  return !!target && target.ownerId === actorId && target.author.id !== actorId;
}

/**
 * Reports a review, comment or post. Reporting the same item again returns the first report
 * rather than creating another, so one account cannot stack reports on an item.
 */
export async function createReport(
  db: Db,
  reporterId: string,
  input: ReportInput,
  now = new Date(),
): Promise<{ id: string; status: ReportStatus; alreadyReported: boolean }> {
  const target = (await loadTargets(db, [input])).get(keyOf(input));
  if (!target) throw errors.notFound("That content no longer exists.");
  if (target.author.id === reporterId) throw errors.conflict("You can't report your own content.");

  const where = {
    reporterId_targetType_targetId: { reporterId, targetType: input.targetType, targetId: input.targetId },
  };
  const existing = await db.contentReport.findUnique({ where, select: { id: true, status: true } });
  if (existing) return { ...existing, alreadyReported: true };

  const recent = await db.contentReport.count({
    where: { reporterId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= REPORTS_PER_HOUR) {
    throw rateLimited(`You can send up to ${REPORTS_PER_HOUR} reports an hour. Try again later.`);
  }

  try {
    const created = await db.contentReport.create({
      data: {
        reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        details: input.details,
        createdAt: now,
      },
      select: { id: true, status: true },
    });
    return { ...created, alreadyReported: false };
  } catch (err) {
    // Lost a race with the same report from another tab.
    if ((err as { code?: unknown }).code !== "P2002") throw err;
    const row = await db.contentReport.findUniqueOrThrow({ where, select: { id: true, status: true } });
    return { ...row, alreadyReported: true };
  }
}

/** Open reports this account may resolve, oldest first. */
export async function listOpenReports(db: Db, actorId: string): Promise<ReportView[]> {
  const rows = await db.contentReport.findMany({
    where: { status: "OPEN" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: QUEUE_LIMIT,
    include: { reporter: { select: { displayName: true } } },
  });
  const targets = await loadTargets(db, rows);

  return rows
    .filter((row) => canResolve(actorId, targets.get(keyOf(row))))
    .map((row) => {
      const target = targets.get(keyOf(row));
      return {
        id: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        reason: row.reason,
        details: row.details,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        reporter: { id: row.reporterId, displayName: row.reporter.displayName },
        target: target
          ? { author: target.author, excerpt: excerpt(target.text, 280), context: target.context, hidden: target.hidden }
          : null,
      };
    });
}

/**
 * Resolves a report. HIDE hides the reported content and closes every open report about it;
 * DISMISS closes this report and leaves the content alone.
 */
export async function resolveReport(
  db: Db,
  actorId: string,
  reportId: string,
  input: ResolveReportInput,
  now = new Date(),
): Promise<{ id: string; status: ReportStatus }> {
  const report = await db.contentReport.findUnique({ where: { id: reportId } });
  if (!report) throw errors.notFound("Report not found");

  const target = (await loadTargets(db, [report])).get(keyOf(report));
  if (!canResolve(actorId, target)) throw errors.forbidden("You can't moderate this content.");
  if (report.status !== "OPEN") throw errors.conflict("This report has already been resolved.");

  const resolved = { resolvedById: actorId, resolvedAt: now };
  if (input.action === "DISMISS") {
    await db.contentReport.update({ where: { id: reportId }, data: { status: "DISMISSED", ...resolved } });
    return { id: reportId, status: "DISMISSED" };
  }

  if (!target) throw errors.conflict("That content has been deleted. Dismiss the report instead.");
  const hide = { hiddenAt: now, hiddenById: actorId, hiddenReason: input.note || report.reason };
  const where = { id: report.targetId };
  await db.$transaction([
    report.targetType === "REVIEW"
      ? db.review.update({ where, data: hide })
      : report.targetType === "COMMENT"
        ? db.postComment.update({ where, data: hide })
        : db.sellerPost.update({ where, data: hide }),
    db.contentReport.updateMany({
      where: { targetType: report.targetType, targetId: report.targetId, status: "OPEN" },
      data: { status: "ACTIONED", ...resolved },
    }),
  ]);
  return { id: reportId, status: "ACTIONED" };
}
