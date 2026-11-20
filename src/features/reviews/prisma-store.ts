/**
 * Review storage on Agent A's `Review` table (#146, XRPL-079).
 * One review per author per event and one per check-in are enforced by unique indexes; a
 * violation surfaces as P2002, which ReviewService maps to 409 ALREADY_REVIEWED.
 */
import type { ReviewInput } from "@/contracts/reviews";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ReviewStore, StoredReview } from "./review-service";

type Db = Pick<PrismaClient, "review">;

const select = {
  id: true,
  eventId: true,
  authorId: true,
  rating: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { displayName: true } },
} as const;

type Row = {
  id: string;
  eventId: string;
  authorId: string;
  rating: number;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  author: { displayName: string };
};

const toStored = (r: Row): StoredReview => ({
  id: r.id,
  eventId: r.eventId,
  authorId: r.authorId,
  authorName: r.author.displayName,
  rating: r.rating,
  body: r.body,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PrismaReviewStore implements ReviewStore {
  constructor(private readonly db: Db) {}

  async findByAuthor(eventId: string, authorId: string): Promise<StoredReview | null> {
    const r = await this.db.review.findUnique({ where: { eventId_authorId: { eventId, authorId } }, select });
    return r ? toStored(r) : null;
  }

  async create(input: { eventId: string; authorId: string; checkInRecordId: string } & ReviewInput): Promise<StoredReview> {
    return toStored(
      await this.db.review.create({
        data: {
          eventId: input.eventId,
          authorId: input.authorId,
          checkInRecordId: input.checkInRecordId,
          rating: input.rating,
          body: input.body,
        },
        select,
      }),
    );
  }

  async update(id: string, input: ReviewInput): Promise<StoredReview> {
    return toStored(await this.db.review.update({ where: { id }, data: { rating: input.rating, body: input.body }, select }));
  }

  async listVisible(eventId: string, limit: number): Promise<StoredReview[]> {
    const rows = await this.db.review.findMany({
      where: { eventId, hiddenAt: null },
      orderBy: { createdAt: "desc" },
      take: limit,
      select,
    });
    return rows.map(toStored);
  }

  async stats(eventId: string): Promise<{ count: number; average: number | null }> {
    const agg = await this.db.review.aggregate({ where: { eventId, hiddenAt: null }, _count: { _all: true }, _avg: { rating: true } });
    return { count: agg._count._all, average: agg._avg.rating ?? null };
  }
}
