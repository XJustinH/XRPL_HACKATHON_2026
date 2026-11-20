import { connection } from "next/server";

import { jsonOk, withApiHandler } from "@/lib/http/response";
import { rethrowAsAppError } from "@/lib/xrpl/http";
import { getXrplQueryService } from "@/lib/xrpl/query";

/**
 * GET /api/xrpl/status: health of the XRPL node in use (XRPL-006/007).
 * 200 { data: XrplNetworkStatus } | 503 LEDGER_UNAVAILABLE.
 */
export const GET = withApiHandler(async (_req, _ctx, { requestId }) => {
  await connection(); // live ledger data: never prerender at build time
  const status = await getXrplQueryService().getNetworkStatus().catch(rethrowAsAppError);
  return jsonOk(status, { requestId, headers: { "Cache-Control": "no-store" } });
});
