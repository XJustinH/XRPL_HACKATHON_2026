// @vitest-environment node
import { describe, expect, it } from "vitest";

import { explorerAccountUrl, explorerNftUrl, explorerTxUrl } from "../explorer";

const config = { explorerUrl: "https://testnet.xrpl.org" };
const HASH = "e3fe6ea3d48f0c2b639448020ea4f03d4f4f8ffdb243a852a0f59177921b4879";

describe("explorer links", () => {
  it("builds transaction, account and NFT links (hex normalised to upper case)", () => {
    expect(explorerTxUrl(config, HASH)).toBe(`https://testnet.xrpl.org/transactions/${HASH.toUpperCase()}`);
    expect(explorerAccountUrl(config, "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe")).toBe(
      "https://testnet.xrpl.org/accounts/rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
    );
    expect(explorerNftUrl(config, HASH)).toBe(`https://testnet.xrpl.org/nft/${HASH.toUpperCase()}`);
  });

  it("rejects malformed identifiers instead of building a broken link", () => {
    expect(() => explorerTxUrl(config, "abc")).toThrow(/64-character hex/);
    expect(() => explorerAccountUrl(config, "not-an-address")).toThrow(/Expected an XRPL classic address/);
    expect(() => explorerNftUrl(config, "../../etc")).toThrow(/64-character hex/);
  });
});
