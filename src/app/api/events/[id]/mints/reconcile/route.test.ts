// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errors } from "@/lib/http/response";
import { XrplServiceError } from "@/lib/xrpl/errors";

const requireSession = vi.fn();
const reconcileEventMappings = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireSession: (req: Request) => requireSession(req) }));
vi.mock("@/lib/xrpl/tickets/server", () => ({ mintingDeps: () => ({ db: "db" }) }));
vi.mock("@/lib/xrpl/tickets/mapping", () => ({
  reconcileEventMappings: (...args: unknown[]) => reconcileEventMappings(...args),
}));

const { POST } = await import("./route");

const EVENT = "3b241101-e2bb-4255-8caf-4136c566a962";
const SESSION = { userId: "u1", role: "SELLER" };
const ctx = (id = EVENT) => ({ params: Promise.resolve({ id }) });
const post = (headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/events/${EVENT}/mints/reconcile`, { method: "POST", headers });

describe("POST /api/events/:id/mints/reconcile", () => {
  beforeEach(() => {
    requireSession.mockReset().mockResolvedValue(SESSION);
    reconcileEventMappings.mockReset();
  });

  it("returns the mapping report, uncached", async () => {
    reconcileEventMappings.mockResolvedValue({ eventId: EVENT, recorded: [], verified: 2, issues: [] });
    const res = await POST(post(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ verified: 2 });
    expect(reconcileEventMappings).toHaveBeenCalledWith({ db: "db" }, { session: SESSION, eventId: EVENT });
  });

  it("requires a session and a well-formed event ID", async () => {
    requireSession.mockRejectedValueOnce(errors.unauthenticated());
    expect((await POST(post(), ctx())).status).toBe(401);
    expect((await POST(post(), ctx("nope"))).status).toBe(404);
    expect(reconcileEventMappings).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    expect((await POST(post({ origin: "https://evil.example" }), ctx())).status).toBe(403);
    expect(reconcileEventMappings).not.toHaveBeenCalled();
  });

  it("answers 503 when the ledger cannot be read", async () => {
    reconcileEventMappings.mockRejectedValue(
      new XrplServiceError("NODE_UNAVAILABLE", "No XRPL node reachable"),
    );
    expect((await POST(post(), ctx())).status).toBe(503);
  });
});
