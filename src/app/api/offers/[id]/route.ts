import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getOfferStatus } from "@/lib/xrpl/offers/purchase";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/offers/:id: an offer's current state after reconciling purchases in flight (XRPL-031).
 * 200 { data: OfferStatus }. A sale shows only once its `NFTokenAcceptOffer` validated; a failed or
 * cancelled purchase leaves the offer ACTIVE if it is still live on the ledger.
 */
export const GET = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Offer not found");
  const status = await withLedgerErrors(() => getOfferStatus(mintingDeps(), id));
  return jsonOk(status, { requestId, headers: { "Cache-Control": "no-store" } });
});
