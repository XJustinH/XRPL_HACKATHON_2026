import { describe, expect, it } from "vitest";
import type { AccountSummary } from "@/contracts/xrpl";
import { assessWalletReadiness, type WalletReadinessInput } from "./wallet-readiness";

const ADDRESS = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    address: ADDRESS,
    exists: true,
    balanceDrops: "100000000", // 100 XRP
    sequence: 1,
    ownerCount: 0,
    provenance: { ledgerIndex: 1, validated: true },
    ...overrides,
  } as AccountSummary;
}

function input(overrides: Partial<WalletReadinessInput> = {}): WalletReadinessInput {
  return {
    address: ADDRESS,
    account: account(),
    // Testnet defaults: 1 XRP base, 0.2 XRP per owned object.
    reserves: { baseDrops: "1000000", incrementDrops: "200000" },
    feeDrops: "12",
    priceDrops: "25000000", // 25 XRP
    network: "XRPL Testnet",
    ...overrides,
  };
}

describe("a wallet that is not connected", () => {
  it("asks for a connection rather than reporting a money problem", () => {
    const result = assessWalletReadiness(input({ address: null }));
    expect(result.status).toBe("NO_WALLET");
    expect(result.canPurchase).toBe(false);
    expect(result.message).toMatch(/connect your wallet/i);
  });
});

describe("an unfunded or unreadable account", () => {
  it("explains that the account needs funding", () => {
    const result = assessWalletReadiness(
      input({ account: account({ exists: false, balanceDrops: null, ownerCount: null }) }),
    );
    expect(result.status).toBe("ACCOUNT_NOT_FOUND");
    expect(result.message).toMatch(/needs funding/i);
  });

  it("says the balance is unknown rather than blaming the wallet", () => {
    for (const override of [
      { account: null },
      { reserves: null },
      { feeDrops: null },
    ] satisfies Partial<WalletReadinessInput>[]) {
      const result = assessWalletReadiness(input(override));
      expect(result.status).toBe("LEDGER_UNAVAILABLE");
      expect(result.canPurchase).toBe(false);
      expect(result.message).toMatch(/could not be checked/i);
    }
  });

  it("treats a malformed drops value as unreadable, not as zero", () => {
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "not-drops" }) }),
    );
    expect(result.status).toBe("LEDGER_UNAVAILABLE");
  });
});

describe("reserves are deducted before anything is called spendable", () => {
  it("subtracts the base reserve and the per-object increment", () => {
    // 100 XRP balance, 1 XRP base + 5 objects x 0.2 XRP = 2 XRP held.
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "100000000", ownerCount: 5 }) }),
    );
    expect(result.spendableDrops).toBe("98000000");
  });

  it("reports zero spendable for a wallet holding exactly its reserve", () => {
    // A positive balance that cannot buy anything.
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "1000000", ownerCount: 0 }) }),
    );
    expect(result.spendableDrops).toBe("0");
    expect(result.canPurchase).toBe(false);
    expect(result.status).toBe("INSUFFICIENT_FUNDS");
  });

  it("never reports negative spendable", () => {
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "500000", ownerCount: 0 }) }),
    );
    expect(result.spendableDrops).toBe("0");
  });
});

describe("the required amount covers price, fee and the new NFT's reserve", () => {
  it("adds one reserve increment for the NFT being bought", () => {
    // 25 XRP price + 12 drops fee + 0.2 XRP increment.
    const result = assessWalletReadiness(input());
    expect(result.requiredDrops).toBe((25_000_000 + 12 + 200_000).toString());
  });

  it("refuses a wallet that covers the price but not the extra reserve", () => {
    // Spendable 25.0001 XRP against a 25 XRP ticket: enough for the price and
    // fee, not for the increment the new NFT requires.
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "26000100", ownerCount: 0 }) }),
    );
    expect(result.spendableDrops).toBe("25000100");
    expect(result.status).toBe("INSUFFICIENT_FUNDS");
    expect(result.shortfallDrops).toBe("199912");
    expect(result.message).toMatch(/raises the reserve/i);
  });

  it("accepts a wallet with exactly enough", () => {
    const required = 25_000_000 + 12 + 200_000;
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: String(required + 1_000_000), ownerCount: 0 }) }),
    );
    expect(result.shortfallDrops).toBeNull();
    expect(result.canPurchase).toBe(true);
    expect(result.status).toBe("READY");
  });

  it("reports the exact shortfall so the buyer knows how much to add", () => {
    const result = assessWalletReadiness(
      input({ account: account({ balanceDrops: "2000000", ownerCount: 0 }) }),
    );
    // Spendable 1 XRP against 25.200012 XRP required.
    expect(result.spendableDrops).toBe("1000000");
    expect(result.shortfallDrops).toBe("24200012");
  });
});

describe("arithmetic precision", () => {
  it("handles amounts beyond safe-integer drops", () => {
    const huge = "90071992547409910000";
    const result = assessWalletReadiness(
      input({
        account: account({ balanceDrops: huge, ownerCount: 0 }),
        priceDrops: "90000000000000000000",
      }),
    );
    expect(result.canPurchase).toBe(true);
    expect(result.spendableDrops).toBe((BigInt(huge) - BigInt(1_000_000)).toString());
  });

  it("allows a free ticket when the wallet can still cover fee and reserve", () => {
    const result = assessWalletReadiness(
      input({ priceDrops: "0", account: account({ balanceDrops: "2000000" }) }),
    );
    expect(result.canPurchase).toBe(true);
  });

  it("still refuses a free ticket when the reserve cannot be met", () => {
    const result = assessWalletReadiness(
      input({ priceDrops: "0", account: account({ balanceDrops: "1000000" }) }),
    );
    expect(result.canPurchase).toBe(false);
  });
});

describe("the reported network", () => {
  it("is carried through so the buyer knows which network they are on", () => {
    expect(assessWalletReadiness(input({ network: "XRPL Testnet" })).network).toBe(
      "XRPL Testnet",
    );
  });
});
