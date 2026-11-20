import { describe, expect, it } from "vitest";
import {
  formatEventDate,
  formatXrp,
  isPastEvent,
  lowestPriceDrops,
} from "./event-formatting";

describe("formatXrp", () => {
  it("converts drops to XRP without floating-point arithmetic", () => {
    expect(formatXrp("1000000")).toBe("1 XRP");
    expect(formatXrp("2500000")).toBe("2.5 XRP");
    expect(formatXrp("0")).toBe("0 XRP");
    expect(formatXrp("1")).toBe("0.000001 XRP");
  });

  it("keeps full precision on values a float would round", () => {
    // 90071992547409.91 XRP is beyond Number.MAX_SAFE_INTEGER in drops.
    expect(formatXrp("90071992547409910000")).toBe("90071992547409.91 XRP");
  });

  it("trims trailing zeros but keeps significant ones", () => {
    expect(formatXrp("1500000")).toBe("1.5 XRP");
    expect(formatXrp("1050000")).toBe("1.05 XRP");
    expect(formatXrp("1000001")).toBe("1.000001 XRP");
  });

  it("degrades to a placeholder rather than throwing on a bad value", () => {
    expect(formatXrp("not-drops")).toBe("—");
    expect(formatXrp("")).toBe("—");
  });
});

describe("lowestPriceDrops", () => {
  it("returns null when there are no tiers", () => {
    expect(lowestPriceDrops([])).toBeNull();
  });

  it("compares numerically, not as strings", () => {
    // "9000000" sorts after "10000000" lexicographically but is cheaper.
    expect(lowestPriceDrops([{ priceDrops: "10000000" }, { priceDrops: "9000000" }])).toBe("9000000");
  });

  it("includes a free tier", () => {
    expect(lowestPriceDrops([{ priceDrops: "5000000" }, { priceDrops: "0" }])).toBe("0");
  });

  it("skips unparseable values instead of failing the page", () => {
    expect(lowestPriceDrops([{ priceDrops: "oops" }, { priceDrops: "7000000" }])).toBe("7000000");
    expect(lowestPriceDrops([{ priceDrops: "oops" }])).toBeNull();
  });
});

describe("formatEventDate", () => {
  it("renders a UTC time deterministically, independent of the host timezone", () => {
    const formatted = formatEventDate("2026-12-01T20:00:00.000Z");
    expect(formatted).toContain("1 Dec 2026");
    expect(formatted).toContain("20:00");
    expect(formatted).toContain("UTC");
  });

  it("does not throw on an invalid timestamp", () => {
    expect(formatEventDate("not-a-date")).toBe("Date unavailable");
  });
});

describe("isPastEvent", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");

  it("identifies past and future events", () => {
    expect(isPastEvent("2026-11-19T12:00:00.000Z", now)).toBe(true);
    expect(isPastEvent("2026-11-21T12:00:00.000Z", now)).toBe(false);
  });

  it("treats an invalid date as not past rather than hiding the event", () => {
    expect(isPastEvent("nonsense", now)).toBe(false);
  });
});
