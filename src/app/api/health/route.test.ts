// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkDatabase = vi.fn();
vi.mock("@/lib/db/client", () => ({ checkDatabase: () => checkDatabase() }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ XRPL_NETWORK: "testnet" }) }));

const { GET } = await import("./route");

describe("GET /api/health", () => {
  beforeEach(() => checkDatabase.mockReset());

  it("returns 200 when the database is reachable", async () => {
    checkDatabase.mockResolvedValue({ ok: true, latencyMs: 3 });
    const res = await GET(new Request("http://localhost/api/health"), {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.data).toMatchObject({ status: "ok", checks: { database: "ok" }, xrplNetwork: "testnet" });
  });

  it("returns 503 in the error envelope when the database is down", async () => {
    checkDatabase.mockResolvedValue({ ok: false, reason: "timeout" });
    const res = await GET(new Request("http://localhost/api/health"), {});
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.error.details).toEqual({ checks: { database: "unavailable" } });
    expect(JSON.stringify(body)).not.toMatch(/postgres|localhost:5432/);
  });
});
