import { z } from "zod";

import { IsoDateTime } from "./common";
import { XrplNetwork } from "./entities";

/**
 * XRPL contract types. Owner: Agent B.
 * Safe to import from server and client code. Ledger primitives (Drops, XrplAddress,
 * NFTokenId, OfferIndex, TxHash) live in ./common and are reused here.
 */

/**
 * Error codes thrown by the XRPL service layer (`XrplServiceError.code`).
 *
 * - CONFIG_ERROR: environment is misconfigured, including any Mainnet setting.
 * - INVALID_INPUT: malformed address/ID/hash, or a request the ledger rejected as malformed.
 * - NOT_FOUND: the account/transaction/object is not on the validated ledger.
 * - TIMEOUT: the node did not answer in time (retryable).
 * - NODE_UNAVAILABLE: no configured node could be reached, or it is busy/not synced (retryable).
 * - WRONG_NETWORK: a node reported a network other than the configured one. Fatal.
 * - RPC_ERROR: any other ledger error response.
 * - UNEXPECTED: an error the service could not classify.
 */
export const XrplErrorCode = z.enum([
  "CONFIG_ERROR",
  "INVALID_INPUT",
  "NOT_FOUND",
  "TIMEOUT",
  "NODE_UNAVAILABLE",
  "WRONG_NETWORK",
  "RPC_ERROR",
  "UNEXPECTED",
]);
export type XrplErrorCode = z.infer<typeof XrplErrorCode>;

/** Serialisable error shape. Never contains secrets. */
export const XrplErrorBody = z.object({
  code: XrplErrorCode,
  message: z.string(),
  retryable: z.boolean(),
});
export type XrplErrorBody = z.infer<typeof XrplErrorBody>;

/** Health of the XRPL node in use (`GET /api/xrpl/status`). */
export const XrplNetworkStatus = z.object({
  network: XrplNetwork,
  networkId: z.number().int(),
  endpoint: z.string(),
  serverState: z.string(),
  buildVersion: z.string().nullable(),
  validatedLedger: z
    .object({
      index: z.number().int(),
      hash: z.string(),
      ageSeconds: z.number(),
    })
    .nullable(),
  checkedAt: IsoDateTime,
});
export type XrplNetworkStatus = z.infer<typeof XrplNetworkStatus>;
