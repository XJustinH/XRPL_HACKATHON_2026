/** In-memory stand-ins for reviews. Test use only. */
import type { ReviewInput } from "@/contracts/reviews";
import type { Attendance, AttendanceVerifier, ReviewStore, StoredReview } from "../review-service";

export class FakeAttendance implements AttendanceVerifier {
  readonly attended = new Set<string>();
  add(userId: string, eventId: string) {
    this.attended.add(`${userId}|${eventId}`);
  }
  async findAttendance(userId: string, eventId: string): Promise<Attendance | null> {
    return this.attended.has(`${userId}|${eventId}`) ? { checkInRecordId: `rec-${userId}` } : null;
  }
}

export class InMemoryReviewStore implements ReviewStore {
  readonly rows: (StoredReview & { hidden: boolean; checkInRecordId: string })[] = [];
  names = new Map<string, string>();
  private t = new Date("2026-12-02T10:00:00.000Z").getTime();
  private seq = 0;

  private tick() {
    this.t += 60_000;
    return new Date(this.t);
  }
  async findByAuthor(eventId: string, authorId: string) {
    return this.rows.find((r) => r.eventId === eventId && r.authorId === authorId) ?? null;
  }
  async create(input: { eventId: string; authorId: string; checkInRecordId: string } & ReviewInput) {
    if (this.rows.some((r) => r.eventId === input.eventId && r.authorId === input.authorId)) {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }
    const now = this.tick();
    const row = {
      id: `review-${++this.seq}`,
      eventId: input.eventId,
      authorId: input.authorId,
      authorName: this.names.get(input.authorId) ?? "Someone",
      rating: input.rating,
      body: input.body,
      createdAt: now,
      updatedAt: now,
      hidden: false,
      checkInRecordId: input.checkInRecordId,
    };
    this.rows.push(row);
    return row;
  }
  async update(id: string, input: ReviewInput) {
    const row = this.rows.find((r) => r.id === id)!;
    Object.assign(row, input, { updatedAt: this.tick() });
    return row;
  }
  async listVisible(eventId: string, limit: number) {
    return this.rows
      .filter((r) => r.eventId === eventId && !r.hidden)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
  async stats(eventId: string) {
    const visible = this.rows.filter((r) => r.eventId === eventId && !r.hidden);
    return {
      count: visible.length,
      average: visible.length ? visible.reduce((n, r) => n + r.rating, 0) / visible.length : null,
    };
  }
}
