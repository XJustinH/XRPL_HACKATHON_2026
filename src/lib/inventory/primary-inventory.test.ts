// @vitest-environment node
import { describe, expect, it } from "vitest";
import { minDrops, summariseEvent, summariseTier, type TierFacts } from "./primary-inventory";

const NOW = new Date("2026-11-20T21:00:00.000Z");
const facts = (over: Partial<TierFacts> = {}): TierFacts => ({
  tierId: "t1",
  name: "GA",
  priceDrops: "25000000",
  totalSupply: 2,
  sold: 0,
  pending: 0,
  activeAsks: [],
  ...over,
});

describe("minDrops", () => {
  it("compares drops as integers, not strings or floats", () => {
    expect(minDrops(["25000000", "9000000", "100000000000000000"])).toBe("9000000");
    expect(minDrops(["10", "9"])).toBe("9"); // "10" < "9" as strings; integers say otherwise
  });

  it("ignores nulls and returns null for nothing", () => {
    expect(minDrops([null, "5", null])).toBe("5");
    expect(minDrops([])).toBeNull();
    expect(minDrops([null])).toBeNull();
  });
});

describe("summariseTier", () => {
  it("counts unminted supply as remaining", () => {
    expect(summariseTier(facts({ totalSupply: 5, sold: 1 }))).toMatchObject({ sold: 1, remaining: 4 });
  });

  it("keeps pending purchases inside remaining (never sold)", () => {
    const t = summariseTier(facts({ totalSupply: 2, sold: 1, pending: 1 }));
    expect(t).toMatchObject({ sold: 1, remaining: 1, pending: 1 });
  });

  it("never reports more pending than remaining, or more sold than supply", () => {
    expect(summariseTier(facts({ totalSupply: 2, sold: 2, pending: 1 }))).toMatchObject({ remaining: 0, pending: 0 });
    expect(summariseTier(facts({ totalSupply: 2, sold: 5 }))).toMatchObject({ sold: 2, remaining: 0 });
  });

  it("offers the cheapest live ask, and none once the tier is sold out", () => {
    expect(summariseTier(facts({ activeAsks: ["30000000", "25000000"] })).fromPriceDrops).toBe("25000000");
    expect(summariseTier(facts({ totalSupply: 1, sold: 1, activeAsks: ["25000000"] })).fromPriceDrops).toBeNull();
  });
});

describe("summariseEvent", () => {
  const tier = (over: Partial<TierFacts>) => summariseTier(facts(over));

  it("is sold out only when every unit of every tier has a validated sale", () => {
    const partial = summariseEvent("e", [tier({ totalSupply: 2, sold: 2 }), tier({ tierId: "t2", totalSupply: 1, sold: 0 })], NOW);
    expect(partial).toMatchObject({ totalSupply: 3, sold: 2, remaining: 1, isSoldOut: false });

    const all = summariseEvent("e", [tier({ totalSupply: 2, sold: 2 }), tier({ tierId: "t2", totalSupply: 1, sold: 1 })], NOW);
    expect(all).toMatchObject({ totalSupply: 3, sold: 3, remaining: 0, isSoldOut: true, fromPriceDrops: null });
  });

  it("is never sold out with no tiers or no supply", () => {
    expect(summariseEvent("e", [], NOW).isSoldOut).toBe(false);
    expect(summariseEvent("e", [tier({ totalSupply: 0 })], NOW).isSoldOut).toBe(false);
  });

  it("is not sold out while the last unit is only pending", () => {
    const e = summariseEvent("e", [tier({ totalSupply: 1, sold: 0, pending: 1 })], NOW);
    expect(e).toMatchObject({ remaining: 1, pending: 1, isSoldOut: false });
  });

  it("reports the event's cheapest live ask across tiers, and its timestamp", () => {
    const e = summariseEvent(
      "e",
      [tier({ activeAsks: ["50000000"] }), tier({ tierId: "t2", activeAsks: ["20000000"] })],
      NOW,
    );
    expect(e.fromPriceDrops).toBe("20000000");
    expect(e.calculatedAt).toBe(NOW.toISOString());
  });
});
