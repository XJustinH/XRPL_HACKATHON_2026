// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const EVENT = "11111111-1111-4111-8111-111111111111";
let session: { userId: string } | null = null;
let sellerId = "seller";

vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    requireSession: async () => {
      if (!session) throw errors.unauthenticated();
      return session;
    },
  };
});

const db = {
  event: { findUnique: async () => ({ sellerId, seller: { role: "SELLER" } }) },
  ticketTier: { aggregate: async () => ({ _sum: { totalSupply: 4 } }) },
  ticketNFT: { count: async () => 2 },
  nFTOffer: { findMany: async () => [{ kind: "PRIMARY", amountDrops: "2500000" }, { kind: "RESALE", amountDrops: "4000000" }] },
  checkInRecord: { findMany: async () => [{ scannedAt: new Date("2026-12-01T20:02:00Z") }] },
};
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const { GET } = await import("./route");
const call = (id: string) =>
  GET(new Request(`http://localhost/api/organisers/events/${id}/metrics`), { params: Promise.resolve({ id }) });

describe("GET /api/organisers/events/:id/metrics", () => {
  beforeEach(() => {
    session = { userId: "seller" };
    sellerId = "seller";
  });

  it("returns metrics to the event's organiser", async () => {
    const res = await call(EVENT);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({
      eventId: EVENT,
      ticketsTotal: 4,
      primarySold: 2,
      primaryRevenueDrops: "2500000",
      resales: 1,
      resaleVolumeDrops: "4000000",
      checkedIn: 1,
      notCheckedIn: 1,
    });
  });

  it("refuses anyone else, unauthenticated users and bad ids", async () => {
    sellerId = "someone-else";
    expect((await call(EVENT)).status).toBe(403);
    session = null;
    expect((await call(EVENT)).status).toBe(401);
    session = { userId: "seller" };
    expect((await call("nope")).status).toBe(400);
  });
});
