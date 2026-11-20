import { ConnectionError, NotFoundError, RippledError, TimeoutError, ValidationError } from "xrpl";

import type { XrplErrorBody, XrplErrorCode } from "@/contracts/xrpl";

const RETRYABLE_CODES: ReadonlySet<XrplErrorCode> = new Set(["TIMEOUT", "NODE_UNAVAILABLE"]);

// rippled/Clio error tokens, grouped by how callers should react.
const NOT_FOUND_ERRORS = new Set([
  "actNotFound",
  "txnNotFound",
  "objectNotFound",
  "entryNotFound",
  "lgrNotFound",
]);
const INVALID_INPUT_ERRORS = new Set([
  "invalidParams",
  "actMalformed",
  "malformedRequest",
  "badSyntax",
  "notImpl",
]);
const UNAVAILABLE_ERRORS = new Set([
  "tooBusy",
  "slowDown",
  "noNetwork",
  "noCurrent",
  "noClosed",
  "notSynced",
  "notReady",
  "amendmentBlocked",
]);

export interface XrplServiceErrorOptions {
  endpoint?: string;
  /** Raw rippled error token, e.g. `actNotFound`. */
  rippledError?: string;
  cause?: unknown;
}

/**
 * The only error type the XRPL service layer throws. Callers switch on `code`
 * and may retry when `retryable` is true.
 */
export class XrplServiceError extends Error {
  override readonly name = "XrplServiceError";
  readonly code: XrplErrorCode;
  readonly retryable: boolean;
  readonly endpoint: string | undefined;
  readonly rippledError: string | undefined;

  constructor(code: XrplErrorCode, message: string, options: XrplServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.endpoint = options.endpoint;
    this.rippledError = options.rippledError;
  }

  /** Safe, serialisable shape for API error bodies. */
  toBody(): XrplErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isXrplServiceError(error: unknown): error is XrplServiceError {
  return error instanceof XrplServiceError;
}

function rippledErrorToken(error: RippledError): string | undefined {
  const data = error.data;
  if (typeof data === "object" && data !== null && "error" in data) {
    const token = (data as { error?: unknown }).error;
    return typeof token === "string" ? token : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Normalises anything thrown by xrpl.js (or our own code) into an
 * XrplServiceError with a stable code.
 */
export function toXrplServiceError(
  error: unknown,
  context: { endpoint?: string; operation?: string } = {},
): XrplServiceError {
  if (error instanceof XrplServiceError) return error;

  const prefix = context.operation ? `${context.operation}: ` : "";
  const base = { endpoint: context.endpoint, cause: error };

  // TimeoutError extends ConnectionError, so it must be checked first.
  if (error instanceof TimeoutError) {
    return new XrplServiceError("TIMEOUT", `${prefix}XRPL node did not respond in time`, base);
  }
  if (error instanceof ConnectionError) {
    return new XrplServiceError(
      "NODE_UNAVAILABLE",
      `${prefix}XRPL node connection failed: ${describe(error)}`,
      base,
    );
  }
  if (error instanceof RippledError) {
    const token = rippledErrorToken(error);
    const options = { ...base, rippledError: token };
    const detail = `${describe(error)}${token ? ` (${token})` : ""}`;
    if (token && NOT_FOUND_ERRORS.has(token)) {
      return new XrplServiceError("NOT_FOUND", `${prefix}${detail}`, options);
    }
    if (token && INVALID_INPUT_ERRORS.has(token)) {
      return new XrplServiceError("INVALID_INPUT", `${prefix}${detail}`, options);
    }
    if (token && UNAVAILABLE_ERRORS.has(token)) {
      return new XrplServiceError("NODE_UNAVAILABLE", `${prefix}${detail}`, options);
    }
    return new XrplServiceError("RPC_ERROR", `${prefix}${detail}`, options);
  }
  if (error instanceof ValidationError) {
    return new XrplServiceError("INVALID_INPUT", `${prefix}${describe(error)}`, base);
  }
  if (error instanceof NotFoundError) {
    return new XrplServiceError("NOT_FOUND", `${prefix}${describe(error)}`, base);
  }
  return new XrplServiceError("UNEXPECTED", `${prefix}${describe(error)}`, base);
}
