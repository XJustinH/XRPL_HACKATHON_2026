// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatDropsAsXrp } from "../format";

describe("formatDropsAsXrp", () => {
  it.each([
    ["0", "0"],
    ["1", "0.000001"],
    ["1000000", "1"],
    ["2500000", "2.5"],
    ["48600000", "48.6"],
    ["100000000000000000", "100000000000"],
  ])("formats %s drops as %s XRP", (drops, xrp) => {
    expect(formatDropsAsXrp(drops)).toBe(xrp);
  });

  it("accepts bigint and negative values", () => {
    expect(formatDropsAsXrp(BigInt(-1500000))).toBe("-1.5");
  });
});
