/** Maps check-in service results onto the standard API envelope. */
import { CHECKIN_FAILURE_STATUSES, CHECKIN_HTTP_STATUS, type CheckInFailure } from "@/contracts/checkin";
import { AppError, jsonOk } from "@/lib/http/response";

const FAILURES = new Set<string>(CHECKIN_FAILURE_STATUSES);

function isCheckInFailure(result: { status?: unknown }): result is CheckInFailure {
  return typeof result.status === "string" && FAILURES.has(result.status);
}

/** Success -> `{ data }` with `successStatus`; failure -> `{ error: { code: <status> } }` with its HTTP status. */
export function checkInResponse<T extends object>(result: T | CheckInFailure, successStatus: number, requestId: string): Response {
  if (isCheckInFailure(result)) {
    throw new AppError(result.status, result.message, CHECKIN_HTTP_STATUS[result.status]);
  }
  return jsonOk(result, { status: successStatus, requestId, headers: { "Cache-Control": "no-store" } });
}

export const walletNotVerified = () =>
  new AppError("WALLET_NOT_VERIFIED", "Connect the XRPL wallet that holds this ticket before checking in.", 403);
