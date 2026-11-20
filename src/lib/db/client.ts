import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";

/**
 * Shared Prisma client (server-only). Owner: Agent A.
 * Use `getDb()` from route handlers and repositories; never construct ad-hoc clients in features.
 */

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Reuse one client across Next.js dev hot reloads.
const globalForPrisma = globalThis as unknown as { __xrplPrisma?: PrismaClient };

export function getDb(): PrismaClient {
  if (!globalForPrisma.__xrplPrisma) {
    globalForPrisma.__xrplPrisma = createPrismaClient(getServerEnv().DATABASE_URL);
  }
  return globalForPrisma.__xrplPrisma;
}

export type DatabaseCheck = { ok: true; latencyMs: number } | { ok: false; reason: "timeout" | "error" };

/** Lightweight readiness probe used by `/api/health`. Does not leak connection details. */
export async function checkDatabase(timeoutMs = 2000, db: Pick<PrismaClient, "$queryRaw"> = getDb()): Promise<DatabaseCheck> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([db.$queryRaw`SELECT 1`.then(() => "ok" as const), timeout]);
    if (outcome === "timeout") return { ok: false, reason: "timeout" };
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}
