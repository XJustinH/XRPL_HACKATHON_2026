// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const enabled = vi.fn(() => true);
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/wallet/transaction-requests", () => ({
  getWalletTransactionRequests: () => ({ create }),
}));
vi.mock("@/lib/xrpl/wallet/test-transactions", () => ({
  testTransactionsEnabled: () => enabled(),
  TEST_TRANSACTION_INSTRUCTION: "Developer check",
}));

const { POST } = await import("./route");

const ACCOUNT = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/wallet/transaction-requests", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("POST /api/wallet/transaction-requests (development only)", () => {
  beforeEach(() => {
    create.mockReset();
    enabled.mockReturnValue(true);
  });

  it("creates a no-op AccountSet approval for the given account", async () => {
    create.mockResolvedValue({ id: "x", status: "PENDING" });
    const res = await POST(post({ purpose: "TEST", account: ACCOUNT }), {});
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      purpose: "TEST",
      txjson: { TransactionType: "AccountSet", Account: ACCOUNT },
      instruction: "Developer check",
    });
  });

  it("is not available when test transactions are disabled", async () => {
    enabled.mockReturnValue(false);
    const res = await POST(post({ purpose: "TEST", account: ACCOUNT }), {});
    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([{ purpose: "MINT_TICKET", account: ACCOUNT }, { purpose: "TEST", account: "nope" }, {}])(
    "rejects %o without calling Xaman",
    async (body) => {
      expect((await POST(post(body), {})).status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-site requests", async () => {
    const res = await POST(
      post({ purpose: "TEST", account: ACCOUNT }, { origin: "https://evil.example" }),
      {},
    );
    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
