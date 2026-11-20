/**
 * Server wiring for reviews (XRPL-079). Server-only.
 * Attendance is real (WalletLink + CheckInRecord). Storage waits on Agent A's `Review` table:
 * until it exists every read and write answers 503 rather than pretending.
 */
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { PrismaAttendance } from "./attendance";
import { ReviewService, type ReviewStore } from "./review-service";

const pending = async (): Promise<never> => {
  throw errors.unavailable("Reviews aren't available yet.");
};

/** Placeholder until the Review table lands; swap for a Prisma store then. */
export const unavailableReviewStore: ReviewStore = {
  findByAuthor: pending,
  create: pending,
  update: pending,
  listVisible: pending,
  stats: pending,
};

const g = globalThis as unknown as { __reviewService?: ReviewService | null };

export function getReviewService(): ReviewService {
  g.__reviewService ??= new ReviewService({ attendance: new PrismaAttendance(getDb()), store: unavailableReviewStore });
  return g.__reviewService;
}

/** Tests only. */
export function setReviewServiceForTests(service: ReviewService | null): void {
  g.__reviewService = service;
}
