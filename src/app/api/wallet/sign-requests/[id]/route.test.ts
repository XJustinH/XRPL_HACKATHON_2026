// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "@/lib/xrpl/errors";

const get = vi.fn();
const cancel = vi.fn();
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/wallet/sign-requests", () => ({ getWalletSignRequests: () => ({ get, cancel }) }));

const { GET, DELETE } = await import("./route");

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string) =>
  new Request(`http://localhost/api/wallet/sign-requests/${UUID}`, { method });

describe("/api/wallet/sign-requests/:id", () => {
  beforeEach(() => {
    get.mockReset();
    cancel.mockReset();
  });

  it("GET returns the current status, uncached", async () => {
    get.mockResolvedValue({ id: UUID, status: "SIGNED", account: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" });
    const res = await GET(request("GET"), ctx(UUID));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data.status).toBe("SIGNED");
    expect(get).toHaveBeenCalledWith(UUID);
  });

  it("DELETE cancels the request", async () => {
    cancel.mockResolvedValue({ id: UUID, status: "CANCELLED" });
    const res = await DELETE(request("DELETE"), ctx(UUID));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("CANCELLED");
  });

  it("maps a malformed ID to 400 and an unknown request to 404", async () => {
    get.mockRejectedValueOnce(new XrplServiceError("INVALID_INPUT", "Sign request ID must be a UUID"));
    expect((await GET(request("GET"), ctx("nope"))).status).toBe(400);

    cancel.mockRejectedValueOnce(new XrplServiceError("NOT_FOUND", "Sign request not found"));
    const res = await DELETE(request("DELETE"), ctx(UUID));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
