import { createHash } from "node:crypto";

import { ErrorCode, IdempotencyKey } from "@/contracts/common";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AppError, errors } from "@/lib/http/response";

/**
 * `Idempotency-Key` support for retriable ledger mutations: mint now, purchases later
 * (docs/architecture.md §5). Backed by Agent A's `IdempotencyRecord` table
 * (unique on scope + route + key). Generic; Agent A may move it to `src/lib/http`.
 *
 * - First request with a key: runs, and the response is stored for 24 hours.
 * - Same key and same request again: the stored response is replayed; nothing runs twice.
 * - Same key with a different request: 422 IDEMPOTENCY_KEY_REUSED.
 * - Same key while the first request is still running: 409, retry shortly.
 * - The operation failed: the key is released, so the client can retry with it.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentResponse<T> {
  status: number;
  body: T;
  /** True when this is a stored response replayed for a repeated key. */
  replayed: boolean;
}

export interface IdempotencyScope {
  /** Raw `Idempotency-Key` header value; null runs the operation without protection. */
  key: string | null;
  /** Who the key belongs to, normally the user ID. Keys never collide across users. */
  scope: string;
  /** Route template, e.g. "POST /api/events/:id/mints". */
  route: string;
  /** Everything that identifies the request (path parameters and body). */
  request: unknown;
}

/** Stable JSON: object keys sorted, so equal requests hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(request: unknown): string {
  return createHash("sha256").update(canonical(request)).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export async function runIdempotent<T>(
  db: Pick<PrismaClient, "idempotencyRecord">,
  { key, scope, route, request }: IdempotencyScope,
  operation: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResponse<T>> {
  if (key === null) return { ...(await operation()), replayed: false };
  if (!IdempotencyKey.safeParse(key).success) {
    throw errors.validation(undefined, "Idempotency-Key must be 8-128 letters, digits, '-' or '_'");
  }

  const hash = requestHash(request);
  const where = { scope_route_key: { scope, route, key } };
  let recordId: string | null = null;
  for (let attempt = 0; attempt < 2 && recordId === null; attempt += 1) {
    try {
      const created = await db.idempotencyRecord.create({
        data: { key, scope, route, requestHash: hash, expiresAt: new Date(Date.now() + TTL_MS) },
        select: { id: true },
      });
      recordId = created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await db.idempotencyRecord.findUnique({ where });
      if (!existing) continue; // released in the meantime: try again
      if (existing.expiresAt <= new Date()) {
        await db.idempotencyRecord.deleteMany({ where: { id: existing.id } });
        continue;
      }
      if (existing.requestHash !== hash) {
        throw new AppError(
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          "This Idempotency-Key was already used for a different request",
          422,
        );
      }
      if (existing.responseStatus === null) {
        throw errors.conflict("A request with this Idempotency-Key is still in progress. Try again shortly.");
      }
      return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
    }
  }
  if (recordId === null) throw errors.conflict("Could not reserve the Idempotency-Key. Try again shortly.");

  try {
    const result = await operation();
    await db.idempotencyRecord.update({
      where: { id: recordId },
      data: { responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
    });
    return { ...result, replayed: false };
  } catch (err) {
    await db.idempotencyRecord.deleteMany({ where: { id: recordId } }).catch(() => undefined);
    throw err;
  }
}
