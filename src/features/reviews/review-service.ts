/**
 * Reviews from verified attendees only (XRPL-079).
 *
 * A customer attended an event when one of their verified, unrevoked wallets was admitted at its
 * door (a CheckInRecord). The check runs on the server for every create and edit; the UI only
 * mirrors it. One review per customer per event; they edit it rather than post again.
 */
import type { EventReviews, ReviewEligibility, ReviewInput, ReviewView } from "@/contracts/reviews";
import { AppError } from "@/lib/http/response";

export type Attendance = { checkInRecordId: string };

export interface AttendanceVerifier {
  /** The customer's admission to this event, or null if none of their verified wallets was admitted. */
  findAttendance(userId: string, eventId: string): Promise<Attendance | null>;
}

export type StoredReview = {
  id: string;
  eventId: string;
  authorId: string;
  authorName: string;
  rating: number;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

export interface ReviewStore {
  findByAuthor(eventId: string, authorId: string): Promise<StoredReview | null>;
  /** Throws a unique-violation error (code P2002) if this author already reviewed the event. */
  create(input: { eventId: string; authorId: string; checkInRecordId: string } & ReviewInput): Promise<StoredReview>;
  update(id: string, input: ReviewInput): Promise<StoredReview>;
  /** Visible (not hidden) reviews, newest first. */
  listVisible(eventId: string, limit: number): Promise<StoredReview[]>;
  /** Count and mean rating of visible reviews. */
  stats(eventId: string): Promise<{ count: number; average: number | null }>;
}

export const REVIEWS_PAGE_SIZE = 50;

const notAttended = () =>
  new AppError("NOT_ATTENDED", "Only people who were checked in at this event can review it.", 403);

export class ReviewService {
  constructor(
    private readonly deps: { attendance: AttendanceVerifier; store: ReviewStore },
  ) {}

  async eligibility(userId: string | null, eventId: string): Promise<ReviewEligibility> {
    if (!userId) return { status: "NOT_SIGNED_IN" };
    const own = await this.deps.store.findByAuthor(eventId, userId);
    if (own) return { status: "ALREADY_REVIEWED", reviewId: own.id };
    return (await this.deps.attendance.findAttendance(userId, eventId)) ? { status: "CAN_REVIEW" } : { status: "NOT_ATTENDED" };
  }

  async list(eventId: string, viewerId: string | null): Promise<EventReviews> {
    const [rows, stats, viewer] = await Promise.all([
      this.deps.store.listVisible(eventId, REVIEWS_PAGE_SIZE),
      this.deps.store.stats(eventId),
      this.eligibility(viewerId, eventId),
    ]);
    return {
      eventId,
      reviews: rows.map(toView),
      count: stats.count,
      averageRating: stats.average === null ? null : Math.round(stats.average * 10) / 10,
      viewer,
    };
  }

  async create(userId: string, eventId: string, input: ReviewInput): Promise<ReviewView> {
    const attendance = await this.deps.attendance.findAttendance(userId, eventId);
    if (!attendance) throw notAttended();
    if (await this.deps.store.findByAuthor(eventId, userId)) throw alreadyReviewed();
    try {
      return toView(await this.deps.store.create({ eventId, authorId: userId, checkInRecordId: attendance.checkInRecordId, ...input }));
    } catch (err) {
      if ((err as { code?: unknown }).code === "P2002") throw alreadyReviewed(); // lost a race with a second tab
      throw err;
    }
  }

  async updateOwn(userId: string, eventId: string, input: ReviewInput): Promise<ReviewView> {
    const own = await this.deps.store.findByAuthor(eventId, userId);
    if (!own) throw new AppError("REVIEW_NOT_FOUND", "You haven't reviewed this event yet.", 404);
    if (!(await this.deps.attendance.findAttendance(userId, eventId))) throw notAttended();
    return toView(await this.deps.store.update(own.id, input));
  }
}

const alreadyReviewed = () =>
  new AppError("ALREADY_REVIEWED", "You've already reviewed this event. Edit your review instead.", 409);

/** Edits more than a second after posting count as edited. */
function toView(r: StoredReview): ReviewView {
  const edited = r.updatedAt.getTime() - r.createdAt.getTime() > 1000;
  return {
    id: r.id,
    eventId: r.eventId,
    author: { id: r.authorId, displayName: r.authorName },
    rating: r.rating,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    editedAt: edited ? r.updatedAt.toISOString() : null,
  };
}
