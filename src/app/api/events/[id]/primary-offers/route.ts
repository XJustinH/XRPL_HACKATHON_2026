import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { getRequestSession } from "@/lib/auth/session";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getEventPrimaryOffers } from "@/lib/xrpl/offers/primary";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/events/:id/primary-offers: the event's live primary sell offers, cheapest first
 * (XRPL-029). Public for published events; a draft's offers only for its owner (404 otherwise).
 * 200 { data: EventPrimaryOffers }. An offer listed here may have been taken on the ledger since;
 * accepting one re-checks it (XRPL-031).
 */
export const GET = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Event not found");
  const session = await getRequestSession(req);
  const offers = await withLedgerErrors(() => getEventPrimaryOffers(mintingDeps(), { session, eventId: id }));
  return jsonOk({ eventId: id, offers }, { requestId, headers: { "Cache-Control": "no-store" } });
});
