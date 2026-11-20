import { ErrorCode } from "@/contracts/common";
import { AppError } from "@/lib/http/response";

import { XrplServiceError } from "./errors";

/** Domain error code for a transaction the ledger validated with a non-tesSUCCESS result. */
export const LEDGER_TX_FAILED = "LEDGER_TX_FAILED";

/**
 * Maps an XRPL service failure onto the shared API error envelope. Anything else is
 * returned unchanged, so `withApiHandler` treats it as usual (unknown -> 500).
 * Node details and endpoints are never exposed to clients.
 */
export function toLedgerAppError(error: unknown): unknown {
  if (!(error instanceof XrplServiceError)) return error;
  switch (error.code) {
    case "INVALID_INPUT":
      return new AppError(ErrorCode.VALIDATION_FAILED, error.message, 400);
    case "NOT_FOUND":
      return new AppError(ErrorCode.NOT_FOUND, "Not found on the validated ledger", 404);
    case "TIMEOUT":
    case "NODE_UNAVAILABLE":
    case "RPC_ERROR":
      return new AppError(
        ErrorCode.LEDGER_UNAVAILABLE,
        "The XRPL node is unavailable. Try again shortly.",
        503,
        {
          retryable: true,
        },
      );
    case "NOT_VALIDATED":
      return new AppError(ErrorCode.LEDGER_TX_NOT_VALIDATED, error.message, 409, { retryable: true });
    case "TX_FAILED":
      return new AppError(LEDGER_TX_FAILED, error.message, 409, { engineResult: error.rippledError ?? null });
    case "CONFIG_ERROR":
    case "WRONG_NETWORK":
      // A server misconfiguration: log the real reason, tell the client only that it is unavailable.
      console.error(`[xrpl] ${error.code}: ${error.message}`);
      return new AppError(ErrorCode.SERVICE_UNAVAILABLE, "XRPL access is not available on this server", 503);
    default:
      return error;
  }
}

/** For `.catch()` in route handlers: rethrow XRPL failures as API errors. */
export function rethrowAsAppError(error: unknown): never {
  throw toLedgerAppError(error);
}
