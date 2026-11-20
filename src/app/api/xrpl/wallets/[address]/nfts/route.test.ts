// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "@/lib/xrpl/errors";

const getAccountNfts = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/query", () => ({ getXrplQueryService: () => ({ getAccountNfts }) }));

const { GET } = await import("./route");

const OWNER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ctx = (address: string) => ({ params: Promise.resolve({ address }) });
const request = (query = "") => new Request(`http://localhost/api/xrpl/wallets/${OWNER}/nfts${query}`);

const PAGE = {
  address: OWNER,
  items: [],
  nextCursor: null,
  provenance: {
    endpoint: "wss://node",
    ledgerIndex: 1,
    ledgerHash: null,
    validated: true,
    fetchedAt: "2026-11-20T18:00:00.000Z",
  },
};

describe("GET /api/xrpl/wallets/:address/nfts", () => {
  beforeEach(() => {
    getAccountNfts.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns a page of NFTs with the default limit", async () => {
    getAccountNfts.mockResolvedValue(PAGE);
    const res = await GET(request(), ctx(OWNER));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toEqual(PAGE);
    expect(getAccountNfts).toHaveBeenCalledWith(OWNER, { limit: 20 });
  });

  it("passes the cursor and limit through", async () => {
    getAccountNfts.mockResolvedValue(PAGE);
    await GET(request("?cursor=abc&limit=50"), ctx(OWNER));
    expect(getAccountNfts).toHaveBeenCalledWith(OWNER, { cursor: "abc", limit: 50 });
  });

  it("rejects a limit above 100 before touching the ledger", async () => {
    const res = await GET(request("?limit=500"), ctx(OWNER));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
    expect(getAccountNfts).not.toHaveBeenCalled();
  });

  it("maps an invalid address to 400 and an unfunded account to 404", async () => {
    getAccountNfts.mockRejectedValueOnce(new XrplServiceError("INVALID_INPUT", "address: not valid"));
    expect((await GET(request(), ctx("bad"))).status).toBe(400);

    getAccountNfts.mockRejectedValueOnce(new XrplServiceError("NOT_FOUND", "actNotFound at wss://node"));
    const res = await GET(request(), ctx(OWNER));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(body)).not.toMatch(/wss:\/\//);
  });
});
