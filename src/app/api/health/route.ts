import { checkDatabase } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";

/**
 * GET /api/health — API and database readiness (XRPL-004).
 * 200 { data: { status: "ok", ... } } | 503 SERVICE_UNAVAILABLE.
 * Exposes no connection strings, versions of dependencies or other internals.
 */
export const GET = withApiHandler(async (_req, _ctx, { requestId }) => {
  const db = await checkDatabase();
  const checks = { database: db.ok ? "ok" : "unavailable" } as const;
  const headers = { "Cache-Control": "no-store" };

  if (!db.ok) {
    throw errors.unavailable("Database is not reachable", { checks });
  }

  return jsonOk(
    {
      status: "ok",
      checks,
      xrplNetwork: getServerEnv().XRPL_NETWORK,
      time: new Date().toISOString(),
    },
    { requestId, headers },
  );
});
