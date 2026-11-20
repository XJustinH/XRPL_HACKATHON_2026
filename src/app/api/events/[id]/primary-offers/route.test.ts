// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";

const getRequestSession = vi.fn();
const getEventPrimaryOffers = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: (req: Request) => getRequestSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/offers/primary", () => ({
  getEventPrimaryOffers: (...args: unknown[]) => getEventPrimaryOffers(...args),
}));

const { GET } = await import("./route");

const EVENT = "3b241101-e2bb-4255-8caf-4136c566a962";
const ctx = (id = EVENT) => ({ params: Promise.resolve({ id }) });
const get = () => new Request(`http://localhost/api/events/${EVENT}/primary-offers`);

describe("GET /api/events/:id/primary-offers", () => {
  beforeEach(() => {
    getRequestSession.mockReset().mockResolvedValue(null);
    getEventPrimaryOffers.mockReset();
  });

  it("lists the event's live offers for anyone, uncached", async () => {
    getEventPrimaryOffers.mockResolvedValue([{ offerId: "o", amountDrops: "1000000" }]);
    const res = await GET(get(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toEqual({
      eventId: EVENT,
      offers: [{ offerId: "o", amountDrops: "1000000" }],
    });
    expect(getEventPrimaryOffers).toHaveBeenCalledWith({ db: "db" }, { session: null, eventId: EVENT });
  });

  it("passes the signed-in session along, so the owner's read reconciles first", async () => {
    getRequestSession.mockResolvedValue({ userId: "u1" });
    getEventPrimaryOffers.mockResolvedValue([]);
    await GET(get(), ctx());
    expect(getEventPrimaryOffers).toHaveBeenCalledWith(
      { db: "db" },
      { session: { userId: "u1" }, eventId: EVENT },
    );
  });

  it("answers 404 for a malformed or hidden event", async () => {
    expect((await GET(get(), ctx("nope"))).status).toBe(404);
    getEventPrimaryOffers.mockRejectedValueOnce(errors.notFound("Event not found"));
    expect((await GET(get(), ctx())).status).toBe(404);
  });
});
