// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const getWalletReadiness = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/query", () => ({ getXrplQueryService: () => ({}) }));
vi.mock("@/lib/xrpl/wallet/readiness", () => ({
  getWalletReadiness: (...args: unknown[]) => getWalletReadiness(...args),
}));

const { GET } = await import("./route");

const ADDRESS = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const request = (query: string) => new Request(`http://localhost/api/wallet/readiness${query}`);

describe("GET /api/wallet/readiness", () => {
  beforeEach(() => getWalletReadiness.mockReset());

  it("returns readiness for the address and required amount", async () => {
    getWalletReadiness.mockResolvedValue({
      status: "CONNECTED",
      balanceDrops: "48600000",
      canPurchase: true,
    });
    const res = await GET(request(`?address=${ADDRESS}&requiredDrops=2500000`), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ balanceDrops: "48600000", canPurchase: true });
    expect(getWalletReadiness.mock.calls[0]![2]).toEqual({ address: ADDRESS, requiredDrops: "2500000" });
  });

  it.each(["", "?address=not-an-address", `?address=${ADDRESS}&requiredDrops=1.5`])(
    "rejects invalid input %s before touching the ledger",
    async (query) => {
      const res = await GET(request(query), {});
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("VALIDATION_FAILED");
      expect(getWalletReadiness).not.toHaveBeenCalled();
    },
  );
});
