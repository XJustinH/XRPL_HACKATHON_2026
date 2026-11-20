/**
 * Agent D contract slice: event reviews from verified attendees (XRPL-079).
 * Ask Agent A to export it from `src/contracts/index.ts`.
 */
import { z } from "zod";
import type { IsoDateTime } from "./common";

export const REVIEW_BODY_MAX = 2000;

/** Body of POST /api/events/:id/reviews and PATCH /api/events/:id/reviews/mine. */
export const ReviewInput = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().max(REVIEW_BODY_MAX).default(""),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export type ReviewView = {
  id: string;
  eventId: string;
  author: { id: string; displayName: string };
  rating: number;
  body: string;
  createdAt: IsoDateTime;
  /** Set when the author edited it after posting. */
  editedAt: IsoDateTime | null;
};

/** Whether the signed-in viewer may write a review, and why not. */
export type ReviewEligibility =
  | { status: "CAN_REVIEW" }
  | { status: "ALREADY_REVIEWED"; reviewId: string } // can edit instead
  | { status: "NOT_ATTENDED" } // no check-in from any of their verified wallets
  | { status: "NOT_SIGNED_IN" };

/** GET /api/events/:id/reviews */
export type EventReviews = {
  eventId: string;
  /** Newest first; hidden (moderated) reviews excluded. */
  reviews: ReviewView[];
  count: number;
  /** Mean rating to one decimal place, or null with no reviews. */
  averageRating: number | null;
  viewer: ReviewEligibility;
};
