// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewService } from "./review-service";
import { unavailableReviewStore } from "./server";
import { FakeAttendance, InMemoryReviewStore } from "./testing/fakes";

const EVENT = "11111111-1111-4111-8111-111111111111";
let session: { userId: string } | null = null;
let visible = true;
let service: ReviewService;

vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    getRequestSession: async () => session,
    requireSession: async () => {
      if (!session) throw errors.unauthenticated();
      return session;
    },
  };
});
vi.mock("@/lib/resale-policy/route-helpers", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    resolveVisibleEventId: async (_req: Request, id: string) => {
      if (!visible) throw errors.notFound("Event not found");
      return id;
    },
  };
});
vi.mock("@/features/reviews/server", async (orig) => ({
  ...(await orig<typeof import("./server")>()),
  getReviewService: () => service,
}));

const { GET, POST } = await import("@/app/api/events/[id]/reviews/route");
const { PATCH } = await import("@/app/api/events/[id]/reviews/mine/route");

const ctx = { params: Promise.resolve({ id: EVENT }) };
const req = (method: string, body?: unknown) =>
  new Request(`http://localhost/api/events/${EVENT}/reviews`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });

beforeEach(() => {
  session = { userId: "alice" };
  visible = true;
  const attendance = new FakeAttendance();
  attendance.add("alice", EVENT);
  service = new ReviewService({ attendance, store: new InMemoryReviewStore() });
});

describe("reviews routes", () => {
  it("attendee posts, everyone reads, author edits", async () => {
    const created = await json(await POST(req("POST", { rating: 5, body: "Brilliant" }), ctx));
    expect(created.status).toBe(201);

    session = null;
    const list = await json(await GET(req("GET"), ctx));
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ count: 1, averageRating: 5, viewer: { status: "NOT_SIGNED_IN" } });

    session = { userId: "alice" };
    const edited = await json(await PATCH(req("PATCH", { rating: 4, body: "Very good" }), ctx));
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ rating: 4 });
  });

  it("maps refusals to clear statuses", async () => {
    session = { userId: "bob" };
    expect((await json(await POST(req("POST", { rating: 3 }), ctx))).body.error.code).toBe("NOT_ATTENDED");
    expect((await PATCH(req("PATCH", { rating: 3 }), ctx)).status).toBe(404);

    session = { userId: "alice" };
    await POST(req("POST", { rating: 3 }), ctx);
    expect((await POST(req("POST", { rating: 3 }), ctx)).status).toBe(409);

    expect((await POST(req("POST", { rating: 9 }), ctx)).status).toBe(400);
    session = null;
    expect((await POST(req("POST", { rating: 3 }), ctx)).status).toBe(401);
    visible = false;
    expect((await GET(req("GET"), ctx)).status).toBe(404);
  });

  it("answers 503 while the Review table doesn't exist yet", async () => {
    const attended = new FakeAttendance();
    attended.add("alice", EVENT); // passes the attendance check, then reaches storage
    service = new ReviewService({ attendance: attended, store: unavailableReviewStore });
    expect((await GET(req("GET"), ctx)).status).toBe(503);
    expect((await POST(req("POST", { rating: 3 }), ctx)).status).toBe(503);
  });

  it("rejects cross-site writes", async () => {
    const res = await POST(
      new Request(`http://localhost/api/events/${EVENT}/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ rating: 5 }),
      }),
      ctx,
    );
    expect(res.status).toBe(403);
  });
});
