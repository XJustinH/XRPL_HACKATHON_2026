import type { WalletReadiness } from "@/contracts/events";

import type { XrplConfig } from "../config";
import { isXrplServiceError } from "../errors";
import { formatDropsAsXrp } from "../format";
import type { XrplQueryService } from "../query";

/**
 * Whether a connected wallet can pay for something on the app's network. Backs
 * WalletPort.getReadiness (XRPL-011/014) and the purchase panel (XRPL-030).
 *
 * `balanceDrops` is the *spendable* balance: total balance minus the account reserve
 * (base + increment x owned objects). `canPurchase` also keeps one increment spare,
 * because receiving an NFT can create a new NFT page that the buyer must reserve for.
 * Throws INVALID_INPUT for a malformed address; ledger outages become a blocker.
 */
export async function getWalletReadiness(
  query: Pick<XrplQueryService, "getAccountInfo" | "getReserves">,
  config: Pick<XrplConfig, "networkLabel">,
  input: { address: string; requiredDrops?: string },
): Promise<WalletReadiness> {
  const base = { status: "CONNECTED" as const, network: config.networkLabel, address: input.address };

  let account: Awaited<ReturnType<XrplQueryService["getAccountInfo"]>>;
  let reserves: Awaited<ReturnType<XrplQueryService["getReserves"]>>;
  try {
    [account, reserves] = await Promise.all([query.getAccountInfo(input.address), query.getReserves()]);
  } catch (error) {
    if (isXrplServiceError(error) && error.code === "INVALID_INPUT") throw error;
    return {
      ...base,
      balanceDrops: null,
      canPurchase: false,
      blockers: ["Couldn't read this wallet's balance from the ledger right now. Try again shortly."],
    };
  }

  if (!account.exists || account.balanceDrops === null) {
    return {
      ...base,
      balanceDrops: null,
      canPurchase: false,
      blockers: [
        `This account isn't active on ${config.networkLabel} yet. It needs at least ${formatDropsAsXrp(reserves.baseDrops)} XRP (the account reserve) before it can hold tickets.`,
      ],
    };
  }

  const zero = BigInt(0);
  const increment = BigInt(reserves.incrementDrops);
  const locked = BigInt(reserves.baseDrops) + increment * BigInt(account.ownerCount ?? 0);
  const balance = BigInt(account.balanceDrops);
  const spendable = balance > locked ? balance - locked : zero;
  const required = BigInt(input.requiredDrops ?? "0");

  const blockers: string[] = [];
  if (spendable === zero) {
    blockers.push("No spendable XRP: everything left is held as the account reserve.");
  } else if (spendable < required + increment) {
    blockers.push(
      `Not enough XRP: ${formatDropsAsXrp(spendable)} XRP spendable, about ${formatDropsAsXrp(required + increment)} XRP needed (price plus ${formatDropsAsXrp(increment)} XRP reserve for the NFT).`,
    );
  }

  return { ...base, balanceDrops: spendable.toString(), canPurchase: blockers.length === 0, blockers };
}
