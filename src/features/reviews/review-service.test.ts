// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { ReviewInput } from "@/contracts/reviews";
import { AppError } from "@/lib/http/response";
import { ReviewService } from "./review-service";
import { FakeAttendance, InMemoryReviewStore } from "./testing/fakes";

const EVENT = "event-1";
const OTHER = "event-2";
let attendance: FakeAttendance;
let store: InMemoryReviewStore;
let svc: ReviewService;

const code = (p: Promise<unknown>) => p.then(() => "OK", (e: unknown) => (e instanceof AppError ? `${e.status} ${e.code}` : String(e)));

beforeEach(() => {
  attendance = new FakeAttendance();
  store = new InMemoryReviewStore();
  store.names.set("alice", "Alice").set("bob", "Bob");
  svc = new ReviewService({ attendance, store });
  attendance.add("alice", EVENT);
});

describe("XRPL-079 reviews from verified attendees", () => {
  it("lets an attendee post one review and shows it to everyone", async () => {
    const review = await svc.create("alice", EVENT, { rating: 5, body: "Great night" });
    expect(review).toMatchObject({ rating: 5, body: "Great night", author: { displayName: "Alice" }, editedAt: null });

    const forBob = await svc.list(EVENT, "bob");
    expect(forBob).toMatchObject({ count: 1, averageRating: 5, viewer: { status: "NOT_ATTENDED" } });
    expect((await svc.list(EVENT, null)).viewer).toEqual({ status: "NOT_SIGNED_IN" });
    expect((await svc.list(EVENT, "alice")).viewer).toEqual({ status: "ALREADY_REVIEWED", reviewId: review.id });
  });

  it("rejects anyone who was not checked in at this event", async () => {
    expect(await code(svc.create("bob", EVENT, { rating: 4, body: "" }))).toBe("403 NOT_ATTENDED");
    expect(await code(svc.create("alice", OTHER, { rating: 4, body: "" }))).toBe("403 NOT_ATTENDED");
    expect(store.rows).toHaveLength(0);
  });

  it("allows only one review per person per event, including a race", async () => {
    await svc.create("alice", EVENT, { rating: 4, body: "" });
    expect(await code(svc.create("alice", EVENT, { rating: 1, body: "" }))).toBe("409 ALREADY_REVIEWED");

    attendance.add("bob", EVENT);
    const both = await Promise.all([
      code(svc.create("bob", EVENT, { rating: 3, body: "" })),
      code(svc.create("bob", EVENT, { rating: 2, body: "" })),
    ]);
    expect(both.sort()).toEqual(["409 ALREADY_REVIEWED", "OK"]);
    expect(store.rows.filter((r) => r.authorId === "bob")).toHaveLength(1);
  });

  it("lets the author edit their own review, marked as edited", async () => {
    await svc.create("alice", EVENT, { rating: 2, body: "meh" });
    const edited = await svc.updateOwn("alice", EVENT, { rating: 4, body: "grew on me" });
    expect(edited).toMatchObject({ rating: 4, body: "grew on me" });
    expect(edited.editedAt).not.toBeNull();
    expect(await code(svc.updateOwn("bob", EVENT, { rating: 1, body: "" }))).toBe("404 REVIEW_NOT_FOUND");
  });

  it("averages to one decimal and hides moderated reviews", async () => {
    attendance.add("bob", EVENT);
    attendance.add("carol", EVENT);
    await svc.create("alice", EVENT, { rating: 5, body: "" });
    await svc.create("bob", EVENT, { rating: 4, body: "" });
    const carol = await svc.create("carol", EVENT, { rating: 4, body: "" });
    expect((await svc.list(EVENT, null)).averageRating).toBe(4.3);

    store.rows.find((r) => r.id === carol.id)!.hidden = true;
    const list = await svc.list(EVENT, null);
    expect(list).toMatchObject({ count: 2, averageRating: 4.5 });
    expect(list.reviews.map((r) => r.author.id)).toEqual(["bob", "alice"]); // newest first
  });

  it("has an empty state", async () => {
    expect(await svc.list(OTHER, null)).toMatchObject({ reviews: [], count: 0, averageRating: null });
  });
});

describe("ReviewInput", () => {
  it("accepts 1-5 whole stars and trims text up to 2000 chars", () => {
    expect(ReviewInput.parse({ rating: 3 })).toEqual({ rating: 3, body: "" });
    expect(ReviewInput.parse({ rating: 5, body: "  hi  " }).body).toBe("hi");
    for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: 3, body: "x".repeat(2001) }, {}]) {
      expect(ReviewInput.safeParse(bad).success).toBe(false);
    }
  });
});
