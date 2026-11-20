// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decode, encode } from "xrpl";
import { makeSignInBlob, newTestKey } from "./testing/signin-blob";
import { verifyXamanSignInBlob } from "./wallet-proof";

const ID = "37edb3c9-52e8-41ff-819c-a4ad7af4c49a";

describe("verifyXamanSignInBlob", () => {
  const key = newTestKey();
  const expected = { signRequestId: ID, account: key.address };

  it("accepts a SignIn signed by the account's master key with the matching memo", () => {
    const blob = makeSignInBlob({ signRequestId: ID, key });
    expect(blob.startsWith("7321ED")).toBe(true); // same layout as a real Xaman blob
    expect(verifyXamanSignInBlob(blob, expected)).toEqual({ ok: true });
  });

  it("matches the request ID case-insensitively", () => {
    const blob = makeSignInBlob({ signRequestId: ID.toUpperCase(), key });
    expect(verifyXamanSignInBlob(blob, expected)).toEqual({ ok: true });
  });

  it("rejects a blob that names a different request (replay of another sign-in)", () => {
    const blob = makeSignInBlob({ signRequestId: "d93ca49c-4776-455d-bf34-d348ea195ef5", key });
    expect(verifyXamanSignInBlob(blob, expected)).toEqual({ ok: false, reason: "MEMO_MISMATCH" });
  });

  it("rejects a wrong memo type or extra memos", () => {
    expect(verifyXamanSignInBlob(makeSignInBlob({ signRequestId: ID, key, memoType: "other" }), expected)).toEqual({
      ok: false,
      reason: "MEMO_MISMATCH",
    });
    expect(verifyXamanSignInBlob(makeSignInBlob({ signRequestId: ID, key, extraMemos: 1 }), expected)).toEqual({
      ok: false,
      reason: "MEMO_MISMATCH",
    });
  });

  it("rejects a forged signature", () => {
    const blob = makeSignInBlob({ signRequestId: ID, key });
    const forgedBy = makeSignInBlob({ signRequestId: "11111111-1111-4111-8111-111111111111", key });
    const tx = decode(blob) as Record<string, unknown>;
    const otherSignature = (decode(forgedBy) as Record<string, unknown>).TxnSignature;
    const forged = encode({ ...tx, TxnSignature: otherSignature } as never);
    expect(verifyXamanSignInBlob(forged, expected)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects garbage", () => {
    expect(verifyXamanSignInBlob("not-hex", expected)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyXamanSignInBlob("", expected).ok).toBe(false);
  });

  it("rejects a submittable transaction posing as a sign-in", () => {
    const blob = makeSignInBlob({ signRequestId: ID, key, extraFields: { TransactionType: "AccountSet" } });
    expect(verifyXamanSignInBlob(blob, expected)).toEqual({ ok: false, reason: "SUBMITTABLE_TX" });
  });

  it("rejects when the blob's account is not the account Xaman reported", () => {
    const blob = makeSignInBlob({ signRequestId: ID, key });
    const other = newTestKey();
    expect(verifyXamanSignInBlob(blob, { signRequestId: ID, account: other.address })).toEqual({
      ok: false,
      reason: "ACCOUNT_MISMATCH",
    });
  });

  it("reports regular-key signatures as unsupported instead of accepting them", () => {
    const account = newTestKey().address;
    const blob = makeSignInBlob({ signRequestId: ID, key, account });
    expect(verifyXamanSignInBlob(blob, { signRequestId: ID, account })).toEqual({
      ok: false,
      reason: "UNSUPPORTED_KEY",
    });
  });
});
