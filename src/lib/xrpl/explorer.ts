import type { z } from "zod";

import { NFTokenId, TxHash, XrplAddress } from "@/contracts/common";
import type { XrplConfig } from "./config";
import { XrplServiceError } from "./errors";

type ExplorerConfig = Pick<XrplConfig, "explorerUrl">;

function parseOrThrow(schema: z.ZodType<string>, value: string): string {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new XrplServiceError("INVALID_INPUT", result.error.issues[0]?.message ?? "Invalid value");
  }
  return result.data;
}

/** Explorer page for a transaction. Only link to transactions you have verified as validated. */
export function explorerTxUrl(config: ExplorerConfig, hash: string): string {
  return `${config.explorerUrl}/transactions/${parseOrThrow(TxHash, hash)}`;
}

export function explorerAccountUrl(config: ExplorerConfig, address: string): string {
  return `${config.explorerUrl}/accounts/${parseOrThrow(XrplAddress, address)}`;
}

export function explorerNftUrl(config: ExplorerConfig, nftokenId: string): string {
  return `${config.explorerUrl}/nft/${parseOrThrow(NFTokenId, nftokenId)}`;
}
