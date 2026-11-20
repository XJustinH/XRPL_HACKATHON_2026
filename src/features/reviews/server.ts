/**
 * Server wiring for reviews (XRPL-079). Server-only.
 * Attendance: WalletLink + CheckInRecord. Storage: Agent A's `Review` table (#146).
 */
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { PrismaAttendance } from "./attendance";
import { PrismaReviewStore } from "./prisma-store";
import { ReviewService, type ReviewStore } from "./review-service";

const pending = async (): Promise<never> => {
  throw errors.unavailable("Reviews aren't available yet.");
};

/** Answers 503 for every call. Kept for tests and for disabling reviews quickly if ever needed. */
export const unavailableReviewStore: ReviewStore = {
  findByAuthor: pending,
  create: pending,
  update: pending,
  listVisible: pending,
  stats: pending,
};

const g = globalThis as unknown as { __reviewService?: ReviewService | null };

export function getReviewService(): ReviewService {
  if (!g.__reviewService) {
    const db = getDb();
    g.__reviewService = new ReviewService({ attendance: new PrismaAttendance(db), store: new PrismaReviewStore(db) });
  }
  return g.__reviewService;
}

/** Tests only. */
export function setReviewServiceForTests(service: ReviewService | null): void {
  g.__reviewService = service;
}
