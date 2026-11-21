import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { COMMENTS_PER_MINUTE, CommentInput, ReportInput, SellerPostInput } from "@/contracts/community";
import { getDb } from "@/lib/db/client";
import { AppError } from "@/lib/http/response";
import { followSeller, listFollowedSellerIds } from "@/features/profiles/follows";
import { PrismaReviewStore } from "@/features/reviews/prisma-store";
import { addComment, deleteComment, listComments, setCommentHidden } from "./comments";
import { likePost, unlikePost } from "./likes";
import { getInbox, markAllNotificationsRead, markNotificationRead, setNotificationOptOut } from "./notifications";
import { createPost, getSellerPostsDashboard, listSellerPosts, updatePost } from "./posts";
import { createReport, listOpenReports, resolveReport } from "./reports";

/** XRPL-080 to XRPL-083 and XRPL-093 on Postgres (`npm run test:db`). */

const db = getDb();
const code = (p: Promise<unknown>) =>
  p.then(
    () => "OK",
    (e: unknown) => (e instanceof AppError ? `${e.status} ${e.code}` : `DB ${(e as { code?: string }).code ?? e}`),
  );

beforeEach(async () => {
  delete process.env.MODERATOR_USER_IDS;
  await db.$executeRawUnsafe(
    `TRUNCATE "Notification","ContentReport","PostComment","PostLike","SellerPost","Review","Follow","Event","User" CASCADE`,
  );
});
afterAll(async () => {
  delete process.env.MODERATOR_USER_IDS;
  await db.$disconnect();
});

async function people() {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const fan = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER" } });
  const other = await db.user.create({ data: { displayName: "Other", role: "CUSTOMER" } });
  return { seller, fan, other };
}
const post = (sellerId: string, body = "Doors at 7") => createPost(db, sellerId, SellerPostInput.parse({ body }));
const comment = (userId: string, postId: string, body: string, now?: Date) =>
  addComment(db, userId, postId, CommentInput.parse({ body }), now);

describe("community on Postgres", () => {
  it("lets only sellers publish and edit their own posts, under the content policy", async () => {
    const { seller, fan } = await people();
    const rival = await db.user.create({ data: { displayName: "Rival", role: "ORGANISER" } });

    expect(await code(post(fan.id))).toBe("403 ROLE_REQUIRED");
    expect(await db.sellerPost.count()).toBe(0);

    const created = await createPost(
      db,
      seller.id,
      SellerPostInput.parse({ body: "  Doors\u0000 at 7\r\n\r\n\r\n\r\nSee you there  ", imageUrl: "https://example.com/a.png" }),
    );
    expect(created).toMatchObject({
      body: "Doors at 7\n\nSee you there",
      imageUrl: "https://example.com/a.png",
      likeCount: 0,
      hidden: false,
    });
    expect(await code(updatePost(db, rival.id, created.id, { body: "Hijacked" }))).toBe("403 FORBIDDEN");
    expect(await updatePost(db, seller.id, created.id, { imageUrl: null })).toMatchObject({
      body: "Doors at 7\n\nSee you there",
      imageUrl: null,
    });

    const rejected = (input: unknown) => !SellerPostInput.safeParse(input).success;
    expect(rejected({ body: "Hi", imageUrl: "http://example.com/a.png" })).toBe(true);
    expect(rejected({ body: "Hi", imageUrl: "javascript:alert(1)" })).toBe(true);
    expect(rejected({ body: " ​ " })).toBe(true);
    expect(rejected({ body: "a".repeat(2001) })).toBe(true);
    expect(rejected({ body: "You absolute WANKERS" })).toBe(true);
    expect(rejected({ body: "Live in Scunthorpe on Friday" })).toBe(false);
  });

  it("counts one like per account and reads the count from the database", async () => {
    const { seller, fan, other } = await people();
    const p = await post(seller.id);

    await likePost(db, fan.id, p.id);
    expect(await likePost(db, fan.id, p.id)).toMatchObject({ liked: true, likeCount: 1 });
    expect(await code(db.postLike.create({ data: { postId: p.id, userId: fan.id } }))).toBe("DB P2002");
    expect((await likePost(db, other.id, p.id)).likeCount).toBe(2);

    expect((await listSellerPosts(db, seller.id, fan.id))[0]).toMatchObject({ likeCount: 2, likedByViewer: true });
    expect(await unlikePost(db, fan.id, p.id)).toMatchObject({ liked: false, likeCount: 1 });
    expect(await unlikePost(db, fan.id, p.id)).toMatchObject({ liked: false, likeCount: 1 });
    expect((await listSellerPosts(db, seller.id, null))[0]).toMatchObject({ likeCount: 1, likedByViewer: false });
    expect((await getSellerPostsDashboard(db, seller.id)).totals).toEqual({ posts: 1, likes: 1, comments: 0 });
  });

  it("rate-limits comments and keeps delete and hide to the right people", async () => {
    const { seller, fan, other } = await people();
    const p = await post(seller.id);
    const now = new Date();

    const first = await comment(fan.id, p.id, "One", now);
    for (let i = 1; i < COMMENTS_PER_MINUTE; i += 1) await comment(fan.id, p.id, `More ${i}`, now);
    expect(await code(comment(fan.id, p.id, "Too many", now))).toBe("429 RATE_LIMITED");
    expect(await code(comment(other.id, p.id, "My first", now))).toBe("OK"); // the limit is per account
    const later = await comment(fan.id, p.id, "A minute later", new Date(now.getTime() + 61_000));

    expect(await code(deleteComment(db, other.id, first.id))).toBe("403 FORBIDDEN");
    expect(await code(setCommentHidden(db, other.id, first.id, true))).toBe("403 FORBIDDEN");

    await setCommentHidden(db, seller.id, first.id, true, "off topic");
    expect((await listComments(db, p.id, other.id)).map((c) => c.id)).not.toContain(first.id);
    expect((await listComments(db, p.id, seller.id)).find((c) => c.id === first.id)).toMatchObject({
      hidden: true,
      canHide: true,
      canDelete: true,
    });
    expect((await listSellerPosts(db, seller.id, null))[0]!.commentCount).toBe(COMMENTS_PER_MINUTE + 1);

    await deleteComment(db, fan.id, later.id); // the author removes their own
    await deleteComment(db, seller.id, first.id); // the seller removes one from their post
    expect(await db.postComment.count()).toBe(COMMENTS_PER_MINUTE);

    // Plain text: markup is stored as written (React escapes it), control characters are dropped.
    expect(CommentInput.parse({ body: "<b>hi</b>\u0007" })).toEqual({ body: "<b>hi</b>" });
  });

  it("hides a reported review and comment from public reads without deleting anything", async () => {
    const { seller, fan, other } = await people();
    const moderator = await db.user.create({ data: { displayName: "Mod", role: "CUSTOMER" } });
    const event = await db.event.create({
      data: {
        sellerId: seller.id,
        title: "Gig",
        startsAt: new Date(Date.now() + 86_400_000),
        venue: "V",
        city: "C",
        status: "PUBLISHED",
        publishedAt: new Date(),
      },
    });
    const review = await db.review.create({ data: { eventId: event.id, authorId: fan.id, rating: 1, body: "Abuse" } });
    const kept = await db.review.create({ data: { eventId: event.id, authorId: other.id, rating: 5, body: "Great" } });
    const reviews = new PrismaReviewStore(db);

    const reviewReport = ReportInput.parse({ targetType: "REVIEW", targetId: review.id, reason: "ABUSE" });
    const report = await createReport(db, other.id, reviewReport);
    expect(await createReport(db, other.id, reviewReport)).toMatchObject({ id: report.id, alreadyReported: true });
    expect(await db.contentReport.count()).toBe(1);

    // Neither the reporter nor the event's seller can moderate a review: only a site moderator.
    expect(await code(resolveReport(db, other.id, report.id, { action: "HIDE" }))).toBe("403 FORBIDDEN");
    expect(await code(resolveReport(db, seller.id, report.id, { action: "HIDE" }))).toBe("403 FORBIDDEN");
    expect(await listOpenReports(db, other.id)).toEqual([]);
    expect(await listOpenReports(db, seller.id)).toEqual([]);
    process.env.MODERATOR_USER_IDS = moderator.id;
    expect((await listOpenReports(db, moderator.id)).map((r) => r.id)).toEqual([report.id]);
    await resolveReport(db, moderator.id, report.id, { action: "HIDE" });
    process.env.MODERATOR_USER_IDS = "";

    expect((await reviews.listVisible(event.id, 50)).map((r) => r.id)).toEqual([kept.id]);
    expect(await reviews.stats(event.id)).toMatchObject({ count: 1, average: 5 });
    expect(await db.review.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({
      body: "Abuse", // kept on record, with who hid it and why
      hiddenById: moderator.id,
      hiddenReason: "ABUSE",
    });

    // A comment, resolved by a site moderator named in MODERATOR_USER_IDS.
    const p = await post(seller.id);
    const bad = await comment(fan.id, p.id, "Buy followers here");
    const fine = await comment(fan.id, p.id, "Looking forward to it");
    const commentReport = await createReport(
      db,
      other.id,
      ReportInput.parse({ targetType: "COMMENT", targetId: bad.id, reason: "SPAM", details: "advert" }),
    );
    expect(await code(resolveReport(db, moderator.id, commentReport.id, { action: "HIDE" }))).toBe("403 FORBIDDEN");
    process.env.MODERATOR_USER_IDS = ` ${moderator.id} , `;
    expect((await listOpenReports(db, moderator.id))[0]).toMatchObject({
      id: commentReport.id,
      target: { excerpt: "Buy followers here", author: { id: fan.id }, hidden: false },
    });
    expect(await resolveReport(db, moderator.id, commentReport.id, { action: "HIDE", note: "advert" })).toMatchObject({
      status: "ACTIONED",
    });

    expect((await listComments(db, p.id, null)).map((c) => c.id)).toEqual([fine.id]);
    expect(await db.postComment.count({ where: { authorId: fan.id } })).toBe(2); // hidden, not deleted
    expect(await code(resolveReport(db, moderator.id, commentReport.id, { action: "DISMISS" }))).toBe("409 CONFLICT");
    expect(await listOpenReports(db, moderator.id)).toEqual([]);
  });

  it("notifies followers once per event, tracks read state and honours the opt-out", async () => {
    const { seller, fan, other } = await people();
    const now = new Date();
    const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);
    const event = (title: string, publishedAt: Date, status: "PUBLISHED" | "DRAFT" = "PUBLISHED") =>
      db.event.create({
        data: {
          sellerId: seller.id,
          title,
          startsAt: hours(24 * 30),
          venue: "V",
          city: "C",
          status,
          publishedAt: status === "PUBLISHED" ? publishedAt : null,
          createdAt: publishedAt,
        },
      });

    await followSeller(db, fan.id, seller.id);
    await db.follow.create({ data: { followerId: fan.id, sellerId: seller.id, createdAt: hours(-2) } });
    await event("Before the follow", hours(-3));
    const gig = await event("New gig", hours(-1));
    await event("Still a draft", hours(-1), "DRAFT");
    await db.sellerPost.create({ data: { sellerId: seller.id, body: "Doors at 7", createdAt: hours(-0.5) } });

    const first = await getInbox(db, fan.id, now);
    expect(first.items.map((item) => item.title)).toEqual(["Doors at 7", "New gig"]);
    expect(first).toMatchObject({ unreadCount: 2, optedOut: false });
    const gigNotice = first.items[1]!;
    expect(gigNotice).toMatchObject({ kind: "NEW_EVENT", href: `/events/${gig.id}`, readAt: null, seller: { id: seller.id } });
    expect((await getInbox(db, other.id, now)).items).toEqual([]); // not a follower

    // Deduplicated: reading again, even twice at once, adds nothing.
    await Promise.all([getInbox(db, fan.id, now), getInbox(db, fan.id, now)]);
    expect(await db.notification.count({ where: { userId: fan.id } })).toBe(2);

    // Read state belongs to the owner and survives the next generation pass.
    expect(await code(markNotificationRead(db, other.id, gigNotice.id))).toBe("404 NOT_FOUND");
    await markNotificationRead(db, fan.id, gigNotice.id);
    const afterRead = await getInbox(db, fan.id, now);
    expect(afterRead.unreadCount).toBe(1);
    expect(afterRead.items[1]!.readAt).not.toBeNull();
    expect(await markAllNotificationsRead(db, fan.id)).toBe(1);

    // Opted out: nothing new is created, and the follow list in the same settings column survives.
    await setNotificationOptOut(db, fan.id, true, hours(1));
    await event("While opted out", hours(2));
    const muted = await getInbox(db, fan.id, hours(3));
    expect(muted.optedOut).toBe(true);
    expect(muted.items.map((item) => item.title)).toEqual(["Doors at 7", "New gig"]);
    expect(await listFollowedSellerIds(db, fan.id)).toEqual([seller.id]);

    // Opting back in starts from that moment.
    await setNotificationOptOut(db, fan.id, false, hours(4));
    await event("After opting back in", hours(5));
    const resumed = await getInbox(db, fan.id, hours(6));
    expect(resumed).toMatchObject({ optedOut: false, unreadCount: 1 });
    expect(resumed.items.map((item) => item.title)).toEqual(["After opting back in", "Doors at 7", "New gig"]);

    // A follow with no dated Follow row falls back to the look-back window.
    await followSeller(db, other.id, seller.id);
    expect((await getInbox(db, other.id, hours(6))).items.map((item) => item.title)).toEqual([
      "After opting back in",
      "While opted out",
      "Doors at 7",
      "New gig",
      "Before the follow",
    ]);
  });
});
