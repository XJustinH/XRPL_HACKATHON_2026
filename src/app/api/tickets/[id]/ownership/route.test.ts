// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";

const getRequestSession = vi.fn();
const resolveTicketOwnership = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ getRequestSession: (req: Request) => getRequestSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/tickets/ownership", () => ({
  resolveTicketOwnership: (...args: unknown[]) => resolveTicketOwnership(...args),
}));

const { GET } = await import("./route");

const TICKET = "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f";
const BUYER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const ctx = (id = TICKET) => ({ params: Promise.resolve({ id }) });
const get = () => new Request(`http://localhost/api/tickets/${TICKET}/ownership`);

describe("GET /api/tickets/:id/ownership", () => {
  beforeEach(() => {
    getRequestSession.mockReset().mockResolvedValue(null);
    resolveTicketOwnership.mockReset();
  });

  it("returns the verified ownership, uncached, comparing with the viewer's proven wallet", async () => {
    getRequestSession.mockResolvedValue({ userId: "u1", walletAddress: BUYER });
    resolveTicketOwnership.mockResolvedValue({
      status: "VERIFIED",
      ownerAddress: BUYER,
      ownedByViewer: true,
    });
    const res = await GET(get(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ status: "VERIFIED", ownedByViewer: true });
    expect(resolveTicketOwnership).toHaveBeenCalledWith(
      { db: "db" },
      { ticketId: TICKET, viewerAddress: BUYER },
    );
  });

  it("works without a session", async () => {
    resolveTicketOwnership.mockResolvedValue({ status: "PENDING", ownerAddress: null });
    expect((await GET(get(), ctx())).status).toBe(200);
    expect(resolveTicketOwnership).toHaveBeenCalledWith(
      { db: "db" },
      { ticketId: TICKET, viewerAddress: null },
    );
  });

  it("answers 404 for a malformed or unknown ticket", async () => {
    expect((await GET(get(), ctx("nope"))).status).toBe(404);
    resolveTicketOwnership.mockRejectedValueOnce(errors.notFound("Ticket not found"));
    expect((await GET(get(), ctx())).status).toBe(404);
  });
});
