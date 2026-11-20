import { z } from "zod";

/**
 * Shared primitives and the API envelope. Owner: Agent A.
 * Safe to import from both server and client code (no server dependencies).
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** App-side UUID. Never use an app ID where an XRPL identifier is expected, or vice versa. */
export const AppId = z.uuid();
export type AppId = z.infer<typeof AppId>;

/** Max drops = 100 billion XRP (total supply). */
export const MAX_DROPS = BigInt("100000000000000000");

/** Integer drops as a decimal string, e.g. "2500000" (= 2.5 XRP). No floats, no signs. */
export const Drops = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,17})$/, "Expected integer drops as a decimal string")
  // Zod 4 runs refinements even after the regex fails, so guard before BigInt().
  .refine((v) => !/^[0-9]+$/.test(v) || BigInt(v) <= MAX_DROPS, "Exceeds total XRP supply");
export type Drops = z.infer<typeof Drops>;

/**
 * XRPL classic address (format check only; base58 checksum is verified by the XRPL adapter, Agent B).
 * Ripple base58 alphabet excludes 0, O, I and l.
 */
export const XrplAddress = z
  .string()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "Expected an XRPL classic address");
export type XrplAddress = z.infer<typeof XrplAddress>;

const hex64 = (label: string) =>
  z
    .string()
    .regex(/^[0-9A-Fa-f]{64}$/, `Expected a 64-character hex ${label}`)
    .transform((v) => v.toUpperCase());

/** On-ledger NFTokenID. Canonicalised to upper-case hex. */
export const NFTokenId = hex64("NFTokenID");
export type NFTokenId = z.infer<typeof NFTokenId>;

/** On-ledger NFT offer index (nft_offer_index). */
export const OfferIndex = hex64("offer index");
export type OfferIndex = z.infer<typeof OfferIndex>;

/** XRPL transaction hash. */
export const TxHash = hex64("transaction hash");
export type TxHash = z.infer<typeof TxHash>;

/** UTC ISO-8601 timestamp with offset, e.g. "2026-11-20T18:00:00.000Z". */
export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PageQuery = z.object({
  /** Opaque cursor returned by the previous page. Do not parse it client-side. */
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

/**
 * Cross-cutting error codes. Domain contracts may add their own codes
 * (e.g. check-in "ALREADY_USED"); keep them UPPER_SNAKE_CASE.
 */
export const ErrorCode = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_JSON: "INVALID_JSON",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  RATE_LIMITED: "RATE_LIMITED",
  LEDGER_UNAVAILABLE: "LEDGER_UNAVAILABLE",
  LEDGER_TX_NOT_VALIDATED: "LEDGER_TX_NOT_VALIDATED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL: "INTERNAL",
} as const;
export type KnownErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const apiSuccess = <T extends z.ZodType>(data: T) => z.object({ data });
export type ApiSuccess<T> = { data: T };
export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

/** Header carrying a client-generated key for retriable mutations (mint / purchase / check-in). */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
