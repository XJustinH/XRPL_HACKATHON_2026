// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const requireSession = vi.fn();
const requestTicketMint = vi.fn();
const getEventMints = vi.fn();
const runIdempotent = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/idempotency", () => ({
  runIdempotent: (...args: unknown[]) => runIdempotent(...args),
}));
vi.mock("@/lib/xrpl/tickets/minting", () => ({
  requestTicketMint: (...args: unknown[]) => requestTicketMint(...args),
  getEventMints: (...args: unknown[]) => getEventMints(...args),
}));

const { GET, POST } = await import("./route");

const EVENT = "3b241101-e2bb-4255-8caf-4136c566a962";
const TIER = "9c8e3a43-6c1f-4d2b-8f0e-2b6f8d8f6c11";
const SESSION = { userId: "u1", role: "SELLER" };
const BODY = { tierId: TIER };
const ctx = (id = EVENT) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/events/${EVENT}/mints`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = () => new Request(`http://localhost/api/events/${EVENT}/mints`);

describe("/api/events/:id/mints", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    requestTicketMint.mockReset();
    getEventMints.mockReset();
    // Pass-through by default: run the operation once.
    runIdempotent.mockReset().mockImplementation(async (_db, _scope, operation: () => Promise<object>) => ({
      ...(await operation()),
      replayed: false,
    }));
  });

  it("POST reserves a ticket and returns the approval request", async () => {
    requestTicketMint.mockResolvedValue({ ticket: { id: "t" }, request: { id: "r" }, metadataPublic: false });
    const res = await POST(post(BODY, { "idempotency-key": "mint-key-123" }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ request: { id: "r" } });
    expect(requestTicketMint).toHaveBeenCalledWith(
      { db: "db" },
      { session: SESSION, eventId: EVENT, tierId: TIER },
    );
    expect(runIdempotent).toHaveBeenCalledWith(
      "db",
      {
        key: "mint-key-123",
        scope: "u1",
        route: "POST /api/events/:id/mints",
        request: { eventId: EVENT, ...BODY },
      },
      expect.any(Function),
    );
  });

  it("POST replays the first response for a repeated Idempotency-Key", async () => {
    runIdempotent.mockResolvedValueOnce({ status: 201, body: { request: { id: "r" } }, replayed: true });
    const res = await POST(post(BODY, { "idempotency-key": "mint-key-123" }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(requestTicketMint).not.toHaveBeenCalled();
  });

  it("GET returns the event's tiers and tickets", async () => {
    getEventMints.mockResolvedValue({ eventId: EVENT, title: "Gig", tiers: [] });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ eventId: EVENT });
    expect(getEventMints).toHaveBeenCalledWith({ db: "db" }, { session: SESSION, eventId: EVENT });
  });

  it("requires a session", async () => {
    requireSession.mockRejectedValue(errors.unauthenticated());
    expect((await POST(post(BODY), ctx())).status).toBe(401);
    expect((await GET(get(), ctx())).status).toBe(401);
    expect(requestTicketMint).not.toHaveBeenCalled();
  });

  it.each([{}, { tierId: "nope" }, { tierId: 7 }])("rejects body %o", async (body) => {
    expect((await POST(post(body), ctx())).status).toBe(400);
    expect(requestTicketMint).not.toHaveBeenCalled();
  });

  it("treats a malformed event ID as not found", async () => {
    expect((await GET(get(), ctx("nope"))).status).toBe(404);
    expect(getEventMints).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    const res = await POST(post(BODY, { origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
    expect(requestTicketMint).not.toHaveBeenCalled();
  });

  it("maps ledger and wallet-service errors", async () => {
    requestTicketMint.mockRejectedValueOnce(
      new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unavailable"),
    );
    expect((await POST(post(BODY), ctx())).status).toBe(503);
    requestTicketMint.mockRejectedValueOnce(errors.conflict("Tier is sold out"));
    expect((await POST(post(BODY), ctx())).status).toBe(409);
  });
});
