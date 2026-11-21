// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

/** The three holder offer routes share one handler (holder-route.ts); each maps its body to an offer. */

const requireSession = vi.fn();
const requestHolderOffer = vi.fn();
const runIdempotent = vi.fn();
const checkResalePrice = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/resale-policy/server", () => ({ getResalePolicy: () => ({ checkResalePrice }) }));
vi.mock("@/lib/xrpl/idempotency", () => ({ runIdempotent: (...args: unknown[]) => runIdempotent(...args) }));
vi.mock("@/lib/xrpl/offers/holder", () => ({
  requestHolderOffer: (...args: unknown[]) => requestHolderOffer(...args),
}));

const resale = await import("./route");
const privateSale = await import("../private-offers/route");
const gift = await import("../gift-offers/route");

const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const FRIEND = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const SESSION = { userId: "u1", role: "CUSTOMER" };
const ctx = (id = TICKET) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/tickets/${TICKET}/offers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("holder offer routes", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    requestHolderOffer.mockReset().mockResolvedValue({ offer: { id: "o" }, request: { id: "r" } });
    checkResalePrice.mockReset().mockReturnValue({ allowed: true, maxDrops: null });
    runIdempotent.mockReset().mockImplementation(async (_db, _scope, operation: () => Promise<object>) => ({
      ...(await operation()),
      replayed: false,
    }));
  });

  it("lists a ticket for resale at the holder's price, with the price cap wired in", async () => {
    const res = await resale.POST(post({ amountDrops: "3000000" }, { "idempotency-key": "resale-key-1" }), ctx());

    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ offer: { id: "o" }, request: { id: "r" } });
    const [deps, input] = requestHolderOffer.mock.calls[0] as [{ resalePrice: (f: string, a: string) => unknown }, object];
    expect(input).toEqual({ session: SESSION, ticketId: TICKET, offer: { kind: "RESALE", amountDrops: "3000000" } });
    deps.resalePrice("2500000", "3000000");
    expect(checkResalePrice).toHaveBeenCalledWith("2500000", "3000000");
    expect(runIdempotent).toHaveBeenCalledWith(
      "db",
      {
        key: "resale-key-1",
        scope: "u1",
        route: "POST /api/tickets/:id/resale-offers",
        request: { ticketId: TICKET, kind: "RESALE", amountDrops: "3000000" },
      },
      expect.any(Function),
    );
  });

  it("sends a private sale and a gift to the named wallet", async () => {
    await privateSale.POST(post({ destination: FRIEND, amountDrops: "2000000" }), ctx());
    await gift.POST(post({ destination: FRIEND }), ctx());

    expect(requestHolderOffer.mock.calls.map((c) => (c[1] as { offer: unknown }).offer)).toEqual([
      { kind: "PRIVATE", amountDrops: "2000000", destination: FRIEND },
      { kind: "GIFT", destination: FRIEND },
    ]);
  });

  it("validates the body before asking the wallet", async () => {
    // A zero price is a gift; a private sale and a gift need a recipient; a gift has no price.
    expect((await resale.POST(post({ amountDrops: "0" }), ctx())).status).toBe(400);
    expect((await resale.POST(post({ amountDrops: "1.5" }), ctx())).status).toBe(400);
    expect((await privateSale.POST(post({ amountDrops: "2000000" }), ctx())).status).toBe(400);
    expect((await gift.POST(post({ destination: FRIEND, amountDrops: "1" }), ctx())).status).toBe(400);
    expect((await gift.POST(post({ destination: "not-an-address" }), ctx())).status).toBe(400);
    expect(requestHolderOffer).not.toHaveBeenCalled();
  });

  it("requires a session and a well-formed ticket ID, and rejects cross-site requests", async () => {
    requireSession.mockRejectedValueOnce(errors.unauthenticated());
    expect((await gift.POST(post({ destination: FRIEND }), ctx())).status).toBe(401);
    expect((await gift.POST(post({ destination: FRIEND }), ctx("nope"))).status).toBe(404);
    expect((await gift.POST(post({ destination: FRIEND }, { origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect(requestHolderOffer).not.toHaveBeenCalled();
  });

  it("maps conflicts and wallet-service outages", async () => {
    requestHolderOffer.mockRejectedValueOnce(errors.conflict("This ticket already has an open offer"));
    expect((await resale.POST(post({ amountDrops: "3000000" }), ctx())).status).toBe(409);
    requestHolderOffer.mockRejectedValueOnce(new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unavailable"));
    expect((await resale.POST(post({ amountDrops: "3000000" }), ctx())).status).toBe(503);
  });
});
