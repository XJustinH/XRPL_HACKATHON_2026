import { connection } from "next/server";
import { z } from "zod";

import { Drops, XrplAddress } from "@/contracts/common";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getXrplQueryService } from "@/lib/xrpl/query";
import { getWalletReadiness } from "@/lib/xrpl/wallet/readiness";

const ReadinessQuery = z.object({
  address: XrplAddress,
  requiredDrops: Drops.optional(),
});

/**
 * GET /api/wallet/readiness?address&requiredDrops: spendable balance and blockers for a
 * wallet on the app's network (XRPL-011, used by XRPL-030). 200 { data: WalletReadiness }.
 * Ledger data is public, so no session is needed.
 */
export const GET = withApiHandler(async (req, _ctx, { requestId }) => {
  await connection();
  const search = new URL(req.url).searchParams;
  const query = ReadinessQuery.parse({
    address: search.get("address") ?? undefined,
    requiredDrops: search.get("requiredDrops") ?? undefined,
  });
  const readiness = await withLedgerErrors(() =>
    getWalletReadiness(getXrplQueryService(), loadXrplConfig(), query),
  );
  return jsonOk(readiness, { requestId, headers: { "Cache-Control": "no-store" } });
});
