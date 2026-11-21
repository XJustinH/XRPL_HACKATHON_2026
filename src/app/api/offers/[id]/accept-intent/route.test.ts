// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const requireSession = vi.fn();
const requestPurchase = vi.fn();
const runIdempotent = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/resale-policy/server", () => ({ getResalePolicy: () => ({ getPublicOffer: async () => null }) }));
vi.mock("@/lib/xrpl/idempotency", () => ({
  runIdempotent: (...args: unknown[]) => runIdempotent(...args),
}));
vi.mock("@/lib/xrpl/offers/purchase", () => ({
  requestPurchase: (...args: unknown[]) => requestPurchase(...args),
}));

const { POST } = await import("./route");

const OFFER = "7be7283c-71b8-47bf-89f0-a0d8183492da";
const SESSION = { userId: "u1", role: "CUSTOMER" };
const ctx = (id = OFFER) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/offers/${OFFER}/accept-intent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/offers/:id/accept-intent", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    requestPurchase.mockReset();
    runIdempotent.mockReset().mockImplementation(async (_db, _scope, operation: () => Promise<object>) => ({
      ...(await operation()),
      replayed: false,
    }));
  });

  it("prepares the purchase and returns the approval request", async () => {
    requestPurchase.mockResolvedValue({ offerId: OFFER, request: { id: "r" } });
    const res = await POST(post({}, { "idempotency-key": "buy-key-123" }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ offerId: OFFER, request: { id: "r" } });
    expect(requestPurchase).toHaveBeenCalledWith(expect.objectContaining({ db: "db", resalePolicy: expect.any(Function) }), { session: SESSION, offerId: OFFER });
    expect(runIdempotent).toHaveBeenCalledWith(
      "db",
      {
        key: "buy-key-123",
        scope: "u1",
        route: "POST /api/offers/:id/accept-intent",
        request: { offerId: OFFER },
      },
      expect.any(Function),
    );
  });

  it("replays the first response for a repeated Idempotency-Key", async () => {
    runIdempotent.mockResolvedValueOnce({ status: 201, body: { offerId: OFFER }, replayed: true });
    const res = await POST(post({}, { "idempotency-key": "buy-key-123" }), ctx());
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(requestPurchase).not.toHaveBeenCalled();
  });

  it("requires a session, a well-formed offer ID and an empty body", async () => {
    requireSession.mockRejectedValueOnce(errors.unauthenticated());
    expect((await POST(post(), ctx())).status).toBe(401);
    expect((await POST(post(), ctx("nope"))).status).toBe(404);
    expect((await POST(post({ buyer: "rSomeoneElse" }), ctx())).status).toBe(400);
    expect(requestPurchase).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    expect((await POST(post({}, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect(requestPurchase).not.toHaveBeenCalled();
  });

  it("maps a sold ticket and a wallet-service outage", async () => {
    requestPurchase.mockRejectedValueOnce(errors.conflict("This ticket is no longer for sale"));
    expect((await POST(post(), ctx())).status).toBe(409);
    requestPurchase.mockRejectedValueOnce(
      new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unavailable"),
    );
    expect((await POST(post(), ctx())).status).toBe(503);
  });
});
