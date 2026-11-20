import { describe, expect, it } from "vitest";
import { dropsToXrpInput, formatXrp, xrpToDrops } from "./event-formatting";

/**
 * Sellers price in XRP, the ledger stores drops. These tests pin the conversion
 * because a rounding error here is a mispriced ticket.
 */

const drops = (input: string) => {
  const result = xrpToDrops(input);
  return result.ok ? result.drops : `REJECTED: ${result.message}`;
};

describe("xrpToDrops", () => {
  it("converts whole and fractional amounts", () => {
    expect(drops("1")).toBe("1000000");
    expect(drops("25")).toBe("25000000");
    expect(drops("2.5")).toBe("2500000");
    expect(drops("0")).toBe("0");
  });

  it("accepts the smallest unit and all six decimal places", () => {
    expect(drops("0.000001")).toBe("1");
    expect(drops("1.234567")).toBe("1234567");
  });

  it("does not lose a drop to floating-point multiplication", () => {
    // 0.1 * 1e6 is 100000.00000000001 as a float.
    expect(drops("0.1")).toBe("100000");
    expect(drops("0.07")).toBe("70000");
    expect(drops("8.7")).toBe("8700000");
    expect(drops("1.005")).toBe("1005000");
  });

  it("keeps precision on amounts beyond safe-integer drops", () => {
    expect(drops("90071992547409.91")).toBe("90071992547409910000");
  });

  it("tolerates surrounding whitespace and a bare decimal point form", () => {
    expect(drops("  2.5  ")).toBe("2500000");
    expect(drops(".5")).toBe("500000");
    expect(drops("5.")).toBe("5000000");
  });

  it("rejects a negative price", () => {
    expect(xrpToDrops("-1")).toMatchObject({ ok: false, message: "Price cannot be negative" });
  });

  it("rejects more precision than XRP supports", () => {
    const result = xrpToDrops("1.1234567");
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ message: expect.stringContaining("6 decimal places") });
  });

  it("rejects empty and non-numeric input", () => {
    for (const bad of ["", "   ", "abc", "1,5", "1e6", "2 5", "$5", "1.2.3", "+1", "."]) {
      expect(xrpToDrops(bad).ok, `${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  it("normalises leading zeros rather than producing an invalid drops string", () => {
    // "007" would fail the contract's drops regex.
    expect(drops("007")).toBe("7000000");
    expect(drops("0.5")).toBe("500000");
  });
});

describe("dropsToXrpInput", () => {
  it("round-trips through xrpToDrops", () => {
    for (const amount of ["0", "1", "2.5", "0.000001", "25", "1.234567", "100"]) {
      const asDrops = drops(amount);
      expect(xrpToDrops(dropsToXrpInput(asDrops)).ok).toBe(true);
      expect(drops(dropsToXrpInput(asDrops))).toBe(asDrops);
    }
  });

  it("emits a bare number with no unit, suitable for an input value", () => {
    expect(dropsToXrpInput("2500000")).toBe("2.5");
    expect(dropsToXrpInput("1000000")).toBe("1");
    expect(dropsToXrpInput("0")).toBe("0");
  });

  it("returns an empty string for an unusable value instead of throwing", () => {
    expect(dropsToXrpInput("")).toBe("");
    expect(dropsToXrpInput("nope")).toBe("");
  });

  it("differs from formatXrp, which is for display and carries the unit", () => {
    expect(dropsToXrpInput("2500000")).toBe("2.5");
    expect(formatXrp("2500000")).toBe("2.5 XRP");
  });
});
