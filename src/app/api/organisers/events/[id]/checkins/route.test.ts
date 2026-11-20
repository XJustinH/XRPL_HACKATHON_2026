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
  ticketNFT: { count: async () => 2 },
  checkInRecord: {
    count: async () => 1,
    findMany: async () => [
      {
        ticketId: "t1",
        walletAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        scannedAt: new Date("2026-12-01T20:01:00.000Z"),
        ticket: { serial: 1, tier: { name: "GA" } },
      },
    ],
  },
};
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const { GET } = await import("./route");
const call = (id: string) => GET(new Request(`http://localhost/api/organisers/events/${id}/checkins`), { params: Promise.resolve({ id }) });

describe("GET /api/organisers/events/:id/checkins", () => {
  beforeEach(() => {
    session = { userId: "seller" };
    sellerId = "seller";
  });

  it("returns the overview to the event's organiser", async () => {
    const res = await call(EVENT);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      eventId: EVENT,
      mintedTickets: 2,
      admitted: 1,
      recent: [
        { ticketId: "t1", serial: 1, tierName: "GA", walletAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", scannedAt: "2026-12-01T20:01:00.000Z" },
      ],
    });
  });

  it("refuses anyone else, unauthenticated users and bad ids", async () => {
    sellerId = "someone-else";
    expect((await call(EVENT)).status).toBe(403);
    session = null;
    expect((await call(EVENT)).status).toBe(401);
    session = { userId: "seller" };
    expect((await call("not-a-uuid")).status).toBe(400);
  });
});
