// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "@/lib/xrpl/errors";

const getTransaction = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/query", () => ({ getXrplQueryService: () => ({ getTransaction }) }));

const { GET } = await import("./route");

const HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const ctx = (hash: string) => ({ params: Promise.resolve({ hash }) });
const request = () => new Request(`http://localhost/api/xrpl/transactions/${HASH}`);

describe("GET /api/xrpl/transactions/:hash", () => {
  beforeEach(() => {
    getTransaction.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the transaction lookup, uncached", async () => {
    getTransaction.mockResolvedValue({ hash: HASH, status: "VALIDATED", succeeded: true });
    const res = await GET(request(), ctx(HASH));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ status: "VALIDATED", succeeded: true });
    expect(getTransaction).toHaveBeenCalledWith(HASH);
  });

  it("treats an unknown hash as a normal NOT_FOUND status, not an error", async () => {
    getTransaction.mockResolvedValue({ hash: HASH, status: "NOT_FOUND", succeeded: false });
    const res = await GET(request(), ctx(HASH));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("NOT_FOUND");
  });

  it("maps a malformed hash to 400 and a node outage to 503", async () => {
    getTransaction.mockRejectedValueOnce(
      new XrplServiceError("INVALID_INPUT", "hash: Expected a 64-character hex"),
    );
    expect((await GET(request(), ctx("abc"))).status).toBe(400);

    getTransaction.mockRejectedValueOnce(new XrplServiceError("TIMEOUT", "slow"));
    const res = await GET(request(), ctx(HASH));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("LEDGER_UNAVAILABLE");
  });
});
