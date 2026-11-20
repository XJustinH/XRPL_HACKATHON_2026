import { connection } from "next/server";

import { AppId, IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { AcceptOfferBody } from "@/contracts/xrpl";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { runIdempotent } from "@/lib/xrpl/idempotency";
import { requestPurchase } from "@/lib/xrpl/offers/purchase";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/offers/:id/accept-intent: prepare the buyer's approval to accept a primary sell offer
 * (XRPL-031). Body `{}`; the buyer is the session's proven wallet. 201 { data: PurchaseRequestResult }:
 * a transaction request (`NFTokenAcceptOffer`) to approve in Xaman. The live offer is re-checked on
 * the ledger first. Send an `Idempotency-Key` header: a repeated key replays the first response.
 * 401 without a session · 403 WALLET_NOT_VERIFIED · 404 unknown offer · 409 no longer for sale,
 * own ticket, can't pay, or someone else is buying it.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Offer not found");
  await parseJsonBody(req, AcceptOfferBody);
  const deps = mintingDeps();
  const result = await runIdempotent(
    deps.db,
    {
      key: req.headers.get(IDEMPOTENCY_KEY_HEADER),
      scope: session.userId,
      route: "POST /api/offers/:id/accept-intent",
      request: { offerId: id },
    },
    async () => ({
      status: 201,
      body: await withLedgerErrors(() => requestPurchase(deps, { session, offerId: id })),
    }),
  );
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (result.replayed) headers["Idempotent-Replayed"] = "true";
  return jsonOk(result.body, { requestId, status: result.status, headers });
});
