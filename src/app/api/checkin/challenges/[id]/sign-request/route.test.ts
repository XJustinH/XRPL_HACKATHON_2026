// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const SIGN_IN = "33333333-3333-4333-8333-333333333333";

let signedIn = true;
let approvable: { status: string; message?: string } = { status: "APPROVABLE" };
const createSignIn = vi.fn();

vi.mock("@/lib/auth/session", async () => {
  const { errors } = await import("@/lib/http/response");
  return {
    requireSession: async () => {
      if (!signedIn) throw errors.unauthenticated();
      return { userId: "u" };
    },
  };
});
vi.mock("@/features/checkin/server", () => ({
  getCheckInService: () => ({ checkApprovable: async () => approvable }),
  getCheckInApproval: () => ({ createSignIn, tokenFor: (c: string, s: string) => `${s}.tag-for-${c}` }),
}));

const { POST } = await import("./route");
const call = (id = CHALLENGE) =>
  POST(new Request(`http://localhost/api/checkin/challenges/${id}/sign-request`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  signedIn = true;
  approvable = { status: "APPROVABLE" };
  createSignIn.mockReset().mockResolvedValue({ id: SIGN_IN, status: "PENDING", signUrl: `https://xumm.app/sign/${SIGN_IN}` });
});

describe("POST /api/checkin/challenges/:id/sign-request", () => {
  it("starts a Xaman sign-in and returns the proof token bound to this challenge", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.signRequest).toMatchObject({ id: SIGN_IN, status: "PENDING" });
    expect(data.proof).toBe(`${SIGN_IN}.tag-for-${CHALLENGE}`);
  });

  it("does not open Xaman for a code that can no longer be approved", async () => {
    approvable = { status: "EXPIRED", message: "expired" };
    const res = await call();
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("EXPIRED");
    expect(createSignIn).not.toHaveBeenCalled();
  });

  it("requires a session and a valid id", async () => {
    expect((await call("nope")).status).toBe(400);
    signedIn = false;
    expect((await call()).status).toBe(401);
  });
});
