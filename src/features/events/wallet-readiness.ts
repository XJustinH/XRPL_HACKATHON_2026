import type { Drops } from "@/contracts";
import type { AccountSummary } from "@/contracts/xrpl";

/**
 * Whether a buyer's wallet can actually complete a purchase (XRPL-030).
 *
 * Pure, because the arithmetic is the part that must be right. Three things
 * routinely make a purchase fail that a naive balance check would miss:
 *
 *  1. **Reserves.** XRPL locks a base reserve plus an increment per owned
 *     object. A wallet holding exactly the reserve has a positive balance and
 *     zero spendable drops.
 *  2. **Buying an NFT increases the owner count**, so the buyer needs one extra
 *     increment of reserve *after* the purchase, not just the price.
 *  3. **The network fee** is paid on top of the price.
 *
 * All amounts are drops as integer strings and all arithmetic is BigInt, so no
 * value passes through a float.
 */

export type WalletReadinessInput = {
  /** Session's verified address, or null when no wallet is linked. */
  address: string | null;
  /** Account facts from the ledger, or null when they could not be read. */
  account: AccountSummary | null;
  reserves: { baseDrops: Drops; incrementDrops: Drops } | null;
  /** Current network fee estimate, or null when unavailable. */
  feeDrops: Drops | null;
  /** The offer's asking price. */
  priceDrops: Drops;
  /** Public network label, shown so a buyer knows which network they are on. */
  network: string;
};

export type WalletReadiness = {
  status:
    | "NO_WALLET"
    | "ACCOUNT_NOT_FOUND"
    | "LEDGER_UNAVAILABLE"
    | "INSUFFICIENT_FUNDS"
    | "READY";
  network: string;
  address: string | null;
  balanceDrops: Drops | null;
  /** Balance minus the reserve the account must keep, floored at zero. */
  spendableDrops: Drops | null;
  feeDrops: Drops | null;
  /** price + fee + the extra reserve increment the new NFT will require. */
  requiredDrops: Drops | null;
  /** How far short the wallet is, when it is short. */
  shortfallDrops: Drops | null;
  canPurchase: boolean;
  /** One sentence a buyer can act on. */
  message: string;
};

const ZERO = BigInt(0);

function bigOrNull(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || !/^[0-9]+$/.test(value)) return null;
  return BigInt(value);
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function assessWalletReadiness(input: WalletReadinessInput): WalletReadiness {
  const base = {
    network: input.network,
    address: input.address,
    balanceDrops: input.account?.balanceDrops ?? null,
    spendableDrops: null,
    feeDrops: input.feeDrops,
    requiredDrops: null,
    shortfallDrops: null,
    canPurchase: false,
  };

  if (!input.address) {
    return {
      ...base,
      status: "NO_WALLET",
      message: "Connect your wallet to buy this ticket.",
    };
  }

  if (input.account === null || input.reserves === null || input.feeDrops === null) {
    // Unknown is not the same as insufficient: say so rather than implying the
    // wallet is at fault.
    return {
      ...base,
      status: "LEDGER_UNAVAILABLE",
      message: `Your balance could not be checked on ${input.network} just now. Try again shortly.`,
    };
  }

  if (!input.account.exists) {
    return {
      ...base,
      status: "ACCOUNT_NOT_FOUND",
      message: `This wallet has no account on ${input.network} yet. It needs funding before it can buy.`,
    };
  }

  const balance = bigOrNull(input.account.balanceDrops);
  const reserveBase = bigOrNull(input.reserves.baseDrops);
  const reserveIncrement = bigOrNull(input.reserves.incrementDrops);
  const fee = bigOrNull(input.feeDrops);
  const price = bigOrNull(input.priceDrops);

  if (balance === null || reserveBase === null || reserveIncrement === null || fee === null || price === null) {
    return {
      ...base,
      status: "LEDGER_UNAVAILABLE",
      message: `Your balance could not be checked on ${input.network} just now. Try again shortly.`,
    };
  }

  const ownerCount = BigInt(input.account.ownerCount ?? 0);
  const heldReserve = reserveBase + ownerCount * reserveIncrement;
  const spendable = max(ZERO, balance - heldReserve);

  // Owning one more NFT raises the account's reserve by one increment.
  const required = price + fee + reserveIncrement;
  const shortfall = max(ZERO, required - spendable);

  const common = {
    ...base,
    balanceDrops: balance.toString(),
    spendableDrops: spendable.toString(),
    feeDrops: fee.toString(),
    requiredDrops: required.toString(),
  };

  if (shortfall > ZERO) {
    return {
      ...common,
      status: "INSUFFICIENT_FUNDS",
      shortfallDrops: shortfall.toString(),
      canPurchase: false,
      message:
        "This wallet does not have enough spendable XRP. Owning another NFT also raises the reserve it must keep.",
    };
  }

  return {
    ...common,
    status: "READY",
    shortfallDrops: null,
    canPurchase: true,
    message: "Your wallet is ready. You will approve the exact amount in your wallet.",
  };
}
