// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const requireSession = vi.fn();
const requestPrimaryOffer = vi.fn();
const runIdempotent = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/idempotency", () => ({
  runIdempotent: (...args: unknown[]) => runIdempotent(...args),
}));
vi.mock("@/lib/xrpl/offers/primary", () => ({
  requestPrimaryOffer: (...args: unknown[]) => requestPrimaryOffer(...args),
}));

const { POST } = await import("./route");

const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const SESSION = { userId: "u1", role: "SELLER" };
const ctx = (id = TICKET) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/tickets/${TICKET}/primary-offers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/tickets/:id/primary-offers", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    requestPrimaryOffer.mockReset();
    runIdempotent.mockReset().mockImplementation(async (_db, _scope, operation: () => Promise<object>) => ({
      ...(await operation()),
      replayed: false,
    }));
  });

  it("starts a listing and returns the approval request", async () => {
    requestPrimaryOffer.mockResolvedValue({ offer: { id: "o" }, request: { id: "r" } });
    const res = await POST(post({}, { "idempotency-key": "list-key-123" }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ offer: { id: "o" }, request: { id: "r" } });
    expect(requestPrimaryOffer).toHaveBeenCalledWith({ db: "db" }, { session: SESSION, ticketId: TICKET });
    expect(runIdempotent).toHaveBeenCalledWith(
      "db",
      {
        key: "list-key-123",
        scope: "u1",
        route: "POST /api/tickets/:id/primary-offers",
        request: { ticketId: TICKET },
      },
      expect.any(Function),
    );
  });

  it("replays the first response for a repeated Idempotency-Key", async () => {
    runIdempotent.mockResolvedValueOnce({ status: 201, body: { offer: { id: "o" } }, replayed: true });
    const res = await POST(post({}, { "idempotency-key": "list-key-123" }), ctx());
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(requestPrimaryOffer).not.toHaveBeenCalled();
  });

  it("requires a session, a well-formed ticket ID and an empty body (the price is the tier's)", async () => {
    requireSession.mockRejectedValueOnce(errors.unauthenticated());
    expect((await POST(post(), ctx())).status).toBe(401);
    expect((await POST(post(), ctx("nope"))).status).toBe(404);
    expect((await POST(post({ amountDrops: "1" }), ctx())).status).toBe(400);
    expect(requestPrimaryOffer).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    expect((await POST(post({}, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect(requestPrimaryOffer).not.toHaveBeenCalled();
  });

  it("maps conflicts and wallet-service outages", async () => {
    requestPrimaryOffer.mockRejectedValueOnce(errors.conflict("This ticket is already for sale"));
    expect((await POST(post(), ctx())).status).toBe(409);
    requestPrimaryOffer.mockRejectedValueOnce(
      new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unavailable"),
    );
    expect((await POST(post(), ctx())).status).toBe(503);
  });
});
