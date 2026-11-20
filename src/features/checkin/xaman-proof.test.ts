// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/http/response";
import { type SignInSource, XamanCheckInProofs } from "./xaman-proof";

const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const OTHER_CHALLENGE = "22222222-2222-4222-8222-222222222222";
const SIGN_IN = "33333333-3333-4333-8333-333333333333";
const ALICE = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SECRET = "proof-secret-that-is-at-least-32-bytes";

function proofs(result: Awaited<ReturnType<SignInSource["getSignedSignIn"]>> | Error, calls: string[] = []) {
  const source: SignInSource = {
    async getSignedSignIn(id) {
      calls.push(id);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return new XamanCheckInProofs(() => source, SECRET);
}

const signed = { request: { account: ALICE, networkMatches: true } };
const verify = (p: XamanCheckInProofs, proof: string, challengeId = CHALLENGE) =>
  p.verify({ challengeId, proof });

describe("XamanCheckInProofs", () => {
  it("returns the signing account for a signed sign-in created for this challenge", async () => {
    const p = proofs(signed);
    expect(await verify(p, p.tokenFor(CHALLENGE, SIGN_IN))).toBe(ALICE);
  });

  it("rejects a token made for another challenge without asking Xaman", async () => {
    const calls: string[] = [];
    const p = proofs(signed, calls);
    expect(await verify(p, p.tokenFor(OTHER_CHALLENGE, SIGN_IN))).toBeNull();
    expect(calls).toEqual([]);
  });

  it("rejects a bare sign-in id (e.g. an old /connect sign-in) and tampered tokens", async () => {
    const p = proofs(signed);
    const token = p.tokenFor(CHALLENGE, SIGN_IN);
    const otherSignIn = "44444444-4444-4444-8444-444444444444";
    for (const bad of [SIGN_IN, `${otherSignIn}.${token.split(".")[1]}`, `${token}x`, `${token}.extra`, "", "a.b"]) {
      expect(await verify(p, bad), bad).toBeNull();
    }
  });

  it("a token from a server with a different secret is rejected", async () => {
    const other = new XamanCheckInProofs(() => ({ getSignedSignIn: async () => signed }), "another-secret-that-is-32-bytes-long!!");
    expect(await verify(proofs(signed), other.tokenFor(CHALLENGE, SIGN_IN))).toBeNull();
  });

  it("rejects unsigned, wrong-network and unknown sign-ins", async () => {
    let p = proofs(null);
    expect(await verify(p, p.tokenFor(CHALLENGE, SIGN_IN))).toBeNull();
    p = proofs({ request: { account: ALICE, networkMatches: false } });
    expect(await verify(p, p.tokenFor(CHALLENGE, SIGN_IN))).toBeNull();
    p = proofs(Object.assign(new Error("gone"), { code: "NOT_FOUND" }));
    expect(await verify(p, p.tokenFor(CHALLENGE, SIGN_IN))).toBeNull();
  });

  it("reports Xaman outages as 503 instead of a failed proof", async () => {
    const p = proofs(Object.assign(new Error("timeout"), { code: "PROVIDER_UNAVAILABLE" }));
    const err = await verify(p, p.tokenFor(CHALLENGE, SIGN_IN)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
  });
});
