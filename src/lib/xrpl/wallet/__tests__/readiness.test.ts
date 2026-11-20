// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { AccountSummary } from "@/contracts/xrpl";

import { XrplServiceError } from "../../errors";
import { getWalletReadiness } from "../readiness";

const ADDRESS = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const config = { networkLabel: "XRPL Testnet" };
const RESERVES = { baseDrops: "1000000", incrementDrops: "200000" }; // 1 XRP + 0.2 XRP per object

function account(balanceDrops: string | null, ownerCount = 0, exists = true): AccountSummary {
  return {
    address: ADDRESS,
    exists,
    balanceDrops,
    sequence: exists ? 1 : null,
    ownerCount: exists ? ownerCount : null,
    provenance: { endpoint: "wss://node", ledgerIndex: 1, ledgerHash: null, validated: true, fetchedAt: "" },
  };
}

function query(summary: AccountSummary | Error) {
  return {
    getAccountInfo: vi.fn(async () => {
      if (summary instanceof Error) throw summary;
      return summary;
    }),
    getReserves: vi.fn(async () => RESERVES),
  };
}

describe("getWalletReadiness", () => {
  it("reports the spendable balance after the account reserve", async () => {
    // 50 XRP, 2 owned objects: 1 + 2 x 0.2 = 1.4 XRP locked.
    const readiness = await getWalletReadiness(query(account("50000000", 2)), config, {
      address: ADDRESS,
      requiredDrops: "10000000",
    });
    expect(readiness).toEqual({
      status: "CONNECTED",
      network: "XRPL Testnet",
      address: ADDRESS,
      balanceDrops: "48600000",
      canPurchase: true,
      blockers: [],
    });
  });

  it("keeps room for the NFT page reserve when checking a purchase", async () => {
    // 48.6 XRP spendable; a 48.5 XRP ticket still needs 0.2 XRP for a possible new NFT page.
    const readiness = await getWalletReadiness(query(account("50000000", 2)), config, {
      address: ADDRESS,
      requiredDrops: "48500000",
    });
    expect(readiness.canPurchase).toBe(false);
    expect(readiness.blockers[0]).toMatch(/48\.6 XRP spendable, about 48\.7 XRP needed/);
  });

  it("explains an account that is not active on the network yet", async () => {
    const readiness = await getWalletReadiness(query(account(null, 0, false)), config, { address: ADDRESS });
    expect(readiness).toMatchObject({ balanceDrops: null, canPurchase: false });
    expect(readiness.blockers[0]).toMatch(/isn't active on XRPL Testnet yet.*at least 1 XRP/);
  });

  it("says when everything is held as reserve", async () => {
    const readiness = await getWalletReadiness(query(account("1400000", 2)), config, { address: ADDRESS });
    expect(readiness).toMatchObject({ balanceDrops: "0", canPurchase: false });
    expect(readiness.blockers[0]).toMatch(/No spendable XRP/);
  });

  it("turns a ledger outage into a blocker instead of failing", async () => {
    const readiness = await getWalletReadiness(query(new XrplServiceError("TIMEOUT", "slow")), config, {
      address: ADDRESS,
    });
    expect(readiness).toMatchObject({ balanceDrops: null, canPurchase: false });
    expect(readiness.blockers[0]).toMatch(/Couldn't read this wallet's balance/);
  });

  it("rethrows a malformed address", async () => {
    await expect(
      getWalletReadiness(query(new XrplServiceError("INVALID_INPUT", "bad")), config, { address: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
