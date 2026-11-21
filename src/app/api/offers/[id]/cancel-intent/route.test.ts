// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const requireSession = vi.fn();
const requestOfferCancellation = vi.fn();
const runIdempotent = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/idempotency", () => ({
  runIdempotent: (...args: unknown[]) => runIdempotent(...args),
}));
vi.mock("@/lib/xrpl/offers/cancel", () => ({
  requestOfferCancellation: (...args: unknown[]) => requestOfferCancellation(...args),
}));

const { POST } = await import("./route");

const OFFER = "7be7283c-71b8-47bf-89f0-a0d8183492da";
const SESSION = { userId: "u1", role: "CUSTOMER" };
const ctx = (id = OFFER) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/offers/${OFFER}/cancel-intent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/offers/:id/cancel-intent", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    requestOfferCancellation.mockReset();
    runIdempotent.mockReset().mockImplementation(async (_db, _scope, operation: () => Promise<object>) => ({
      ...(await operation()),
      replayed: false,
    }));
  });

  it("prepares the cancellation and returns the approval request", async () => {
    requestOfferCancellation.mockResolvedValue({ offer: { id: OFFER, state: "ACTIVE" }, request: { id: "r" } });
    const res = await POST(post({}, { "idempotency-key": "cancel-key-1" }), ctx());
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ offer: { id: OFFER, state: "ACTIVE" }, request: { id: "r" } });
    expect(requestOfferCancellation).toHaveBeenCalledWith({ db: "db" }, { session: SESSION, offerId: OFFER });
    expect(runIdempotent).toHaveBeenCalledWith(
      "db",
      { key: "cancel-key-1", scope: "u1", route: "POST /api/offers/:id/cancel-intent", request: { offerId: OFFER } },
      expect.any(Function),
    );
  });

  it("replays the first response for a repeated Idempotency-Key", async () => {
    runIdempotent.mockResolvedValueOnce({ status: 201, body: { offer: { id: OFFER } }, replayed: true });
    const res = await POST(post({}, { "idempotency-key": "cancel-key-1" }), ctx());
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(requestOfferCancellation).not.toHaveBeenCalled();
  });

  it("requires a session, a well-formed offer ID and an empty body", async () => {
    requireSession.mockRejectedValueOnce(errors.unauthenticated());
    expect((await POST(post(), ctx())).status).toBe(401);
    expect((await POST(post(), ctx("nope"))).status).toBe(404);
    expect((await POST(post({ owner: "rSomeoneElse" }), ctx())).status).toBe(400);
    expect(requestOfferCancellation).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    expect((await POST(post({}, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect(requestOfferCancellation).not.toHaveBeenCalled();
  });

  it("maps a closed offer and a wallet-service outage", async () => {
    requestOfferCancellation.mockRejectedValueOnce(errors.conflict("This offer is no longer open"));
    expect((await POST(post(), ctx())).status).toBe(409);
    requestOfferCancellation.mockRejectedValueOnce(new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unavailable"));
    expect((await POST(post(), ctx())).status).toBe(503);
  });
});
