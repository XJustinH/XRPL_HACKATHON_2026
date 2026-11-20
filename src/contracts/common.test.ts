import { describe, expect, it } from "vitest";
import { ApiErrorBody, Drops, IdempotencyKey, NFTokenId, PageQuery, TxHash, XrplAddress } from "./common";

describe("Drops", () => {
  it.each(["0", "1", "2500000", "100000000000000000"])("accepts %s", (v) => {
    expect(Drops.parse(v)).toBe(v);
  });

  it.each(["", "01", "-1", "1.5", "1e6", " 1", "100000000000000001", "abc"])("rejects %j", (v) => {
    expect(Drops.safeParse(v).success).toBe(false);
  });

  it("rejects numbers (floats must never reach the API)", () => {
    expect(Drops.safeParse(2500000).success).toBe(false);
  });
});

describe("XrplAddress", () => {
  it("accepts a well-formed classic address", () => {
    expect(XrplAddress.safeParse("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh").success).toBe(true);
  });

  it.each(["", "xHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "r0b9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "rShort"])(
    "rejects %j",
    (v) => {
      expect(XrplAddress.safeParse(v).success).toBe(false);
    },
  );
});

describe("64-hex ledger identifiers", () => {
  const lower = "000800006203f49c21d5d6e022cb16de3538f248662fc73c00000ba200000000".slice(0, 64);

  it("canonicalises NFTokenID to upper case", () => {
    expect(NFTokenId.parse(lower)).toBe(lower.toUpperCase());
  });

  it("rejects wrong length or non-hex", () => {
    expect(TxHash.safeParse("ABC").success).toBe(false);
    expect(TxHash.safeParse("Z".repeat(64)).success).toBe(false);
  });

  it("does not accept an app UUID as a token id", () => {
    expect(NFTokenId.safeParse("6f1c1f3e-2b8a-4d6c-9a51-1f8f0d2b7c11").success).toBe(false);
  });
});

describe("PageQuery", () => {
  it("defaults and coerces limit", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
    expect(PageQuery.parse({ limit: "5" }).limit).toBe(5);
  });

  it("caps limit at 100", () => {
    expect(PageQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("IdempotencyKey", () => {
  it("accepts UUID-like keys and rejects short or unsafe ones", () => {
    expect(IdempotencyKey.safeParse("6f1c1f3e-2b8a-4d6c-9a51-1f8f0d2b7c11").success).toBe(true);
    expect(IdempotencyKey.safeParse("short").success).toBe(false);
    expect(IdempotencyKey.safeParse("has spaces in it").success).toBe(false);
  });
});

describe("ApiErrorBody", () => {
  it("matches the agreed failure envelope", () => {
    expect(
      ApiErrorBody.safeParse({ error: { code: "NOT_FOUND", message: "Not found" }, requestId: "req-12345678" })
        .success,
    ).toBe(true);
    expect(ApiErrorBody.safeParse({ error: { code: "not_found", message: "x" }, requestId: "r" }).success).toBe(
      false,
    );
  });
});
