import { connection } from "next/server";

import { PageQuery } from "@/contracts/common";
import { jsonOk, withApiHandler } from "@/lib/http/response";
import { rethrowAsAppError } from "@/lib/xrpl/http";
import { getXrplQueryService } from "@/lib/xrpl/query";

/**
 * GET /api/xrpl/wallets/:address/nfts?cursor&limit: NFTs a wallet holds on the
 * validated ledger, paginated (XRPL-007, used by XRPL-028/033).
 * 200 { data: AccountNftsPage } | 400 | 404 (unfunded account) | 503.
 * Ledger data is public; presentation decides what to show.
 */
export const GET = withApiHandler<{ params: Promise<{ address: string }> }>(
  async (req, ctx, { requestId }) => {
    await connection();
    const { address } = await ctx.params;
    const search = new URL(req.url).searchParams;
    const query = PageQuery.parse({
      cursor: search.get("cursor") ?? undefined,
      limit: search.get("limit") ?? undefined,
    });
    const page = await getXrplQueryService().getAccountNfts(address, query).catch(rethrowAsAppError);
    return jsonOk(page, { requestId, headers: { "Cache-Control": "no-store" } });
  },
);
