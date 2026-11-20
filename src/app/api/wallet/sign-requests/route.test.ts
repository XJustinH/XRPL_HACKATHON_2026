// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XrplServiceError } from "@/lib/xrpl/errors";

const createSignIn = vi.fn();
const service = vi.fn(() => ({ createSignIn }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/xrpl/wallet/sign-requests", () => ({ getWalletSignRequests: () => service() }));

const { POST } = await import("./route");

const UUID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const post = (body: unknown) =>
  new Request("http://localhost/api/wallet/sign-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/wallet/sign-requests", () => {
  beforeEach(() => {
    createSignIn.mockReset();
    service.mockImplementation(() => ({ createSignIn }));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("creates a sign-in request", async () => {
    createSignIn.mockResolvedValue({ id: UUID, kind: "SIGN_IN", status: "PENDING" });
    const res = await POST(post({ kind: "SIGN_IN" }), {});
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).data).toMatchObject({ id: UUID, status: "PENDING" });
  });

  it("rejects unknown kinds and malformed JSON before calling Xaman", async () => {
    expect((await POST(post({ kind: "MINT" }), {})).status).toBe(400);
    expect((await POST(post("{"), {})).status).toBe(400);
    expect(createSignIn).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests (CSRF) before calling Xaman", async () => {
    const crossSite = new Request("http://localhost/api/wallet/sign-requests", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ kind: "SIGN_IN" }),
    });
    expect((await POST(crossSite, {})).status).toBe(403);
    expect(createSignIn).not.toHaveBeenCalled();
  });

  it("reports missing Xaman configuration as 503 without details", async () => {
    service.mockImplementation(() => {
      throw new XrplServiceError("CONFIG_ERROR", "Wallet signing is not configured: set XAMAN_API_KEY");
    });
    const res = await POST(post({ kind: "SIGN_IN" }), {});
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/XAMAN_API/);
  });

  it("reports a Xaman outage as retryable 503", async () => {
    createSignIn.mockRejectedValue(new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman did not respond"));
    const res = await POST(post({ kind: "SIGN_IN" }), {});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      details: { retryable: true },
    });
  });
});
