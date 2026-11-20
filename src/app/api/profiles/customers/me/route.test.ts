// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

let session: { userId: string } | null = null;
const update = vi.fn();
const get = vi.fn();

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    requireSession: async () => {
      if (!session) throw errors.unauthenticated();
      return session;
    },
  };
});
vi.mock("@/features/profiles/customer-profile", () => ({
  getOwnCustomerProfile: (...args: unknown[]) => get(...args),
  updateOwnCustomerProfile: (...args: unknown[]) => update(...args),
}));

const { ProfileNotFoundError } = await import("@/features/profiles/profile-store");
const { GET, PATCH } = await import("./route");

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/profiles/customers/me", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  session = { userId: "u1" };
  get.mockReset().mockResolvedValue({ id: "u1", displayName: "Aoife", imageUrl: null });
  update.mockReset().mockResolvedValue({ id: "u1", displayName: "Aoife M", imageUrl: "https://img.example/a.png" });
});

describe("/api/profiles/customers/me (XRPL-056)", () => {
  it("returns and edits only the caller's own profile", async () => {
    expect((await (await GET(req("GET"), {})).json()).data).toMatchObject({ displayName: "Aoife" });
    expect(get).toHaveBeenCalledWith({}, "u1");

    const res = await PATCH(req("PATCH", { displayName: "Aoife M", imageUrl: "https://img.example/a.png" }), {});
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({}, "u1", { displayName: "Aoife M", imageUrl: "https://img.example/a.png" });
  });

  it("ignores fields it doesn't own, such as role or another user's id", async () => {
    await PATCH(req("PATCH", { displayName: "Aoife M", role: "ORGANISER", userId: "someone-else" }), {});
    expect(update).toHaveBeenCalledWith({}, "u1", { displayName: "Aoife M" });
  });

  it("rejects invalid input, unsafe links and signed-out callers", async () => {
    expect((await PATCH(req("PATCH", { displayName: "A" }), {})).status).toBe(400);
    expect((await PATCH(req("PATCH", { imageUrl: "javascript:alert(1)" }), {})).status).toBe(400);
    session = null;
    expect((await GET(req("GET"), {})).status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it("maps a missing profile to 404", async () => {
    get.mockRejectedValue(new ProfileNotFoundError("Profile not found"));
    expect((await GET(req("GET"), {})).status).toBe(404);
  });

  it("rejects cross-site writes", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/profiles/customers/me", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ displayName: "Mallory" }),
      }),
      {},
    );
    expect(res.status).toBe(403);
  });
});
