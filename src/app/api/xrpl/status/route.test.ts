// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "@/lib/xrpl/errors";

const getNetworkStatus = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/query", () => ({ getXrplQueryService: () => ({ getNetworkStatus }) }));

const { GET } = await import("./route");

const STATUS = {
  network: "TESTNET",
  networkId: 1,
  endpoint: "wss://s.altnet.rippletest.net:51233/",
  serverState: "full",
  buildVersion: "3.4.1",
  validatedLedger: { index: 100, hash: "ABC", ageSeconds: 2 },
  checkedAt: "2026-11-20T18:00:00.000Z",
};

describe("GET /api/xrpl/status", () => {
  beforeEach(() => {
    getNetworkStatus.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the node status, uncached", async () => {
    getNetworkStatus.mockResolvedValue(STATUS);
    const res = await GET(new Request("http://localhost/api/xrpl/status"), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toEqual(STATUS);
  });

  it("returns 503 LEDGER_UNAVAILABLE without node details when no node answers", async () => {
    getNetworkStatus.mockRejectedValue(
      new XrplServiceError("NODE_UNAVAILABLE", "Could not connect to wss://s.altnet.rippletest.net:51233/"),
    );
    const res = await GET(new Request("http://localhost/api/xrpl/status"), {});
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toMatchObject({ code: "LEDGER_UNAVAILABLE", details: { retryable: true } });
    expect(JSON.stringify(body)).not.toMatch(/wss:\/\//);
  });

  it("hides misconfiguration details (e.g. a Mainnet node) from clients", async () => {
    getNetworkStatus.mockRejectedValue(
      new XrplServiceError("WRONG_NETWORK", "wss://s1.ripple.com/ reported network_id 0 (XRPL Mainnet)"),
    );
    const res = await GET(new Request("http://localhost/api/xrpl/status"), {});
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/ripple\.com|network_id/);
  });
});
