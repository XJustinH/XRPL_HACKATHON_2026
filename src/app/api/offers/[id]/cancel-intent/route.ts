import { connection } from "next/server";

import { AppId, IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { CancelOfferBody } from "@/contracts/xrpl";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { runIdempotent } from "@/lib/xrpl/idempotency";
import { requestOfferCancellation } from "@/lib/xrpl/offers/cancel";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/offers/:id/cancel-intent: prepare the owner's approval to cancel their open sell offer
 * (XRPL-042), whatever its kind. Body `{}`; the owner is the session's proven wallet.
 * 201 { data: OfferCancelRequestResult }: the offer, still ACTIVE, and a transaction request
 * (`NFTokenCancelOffer`) to approve in Xaman. Poll `GET /api/offers/:id`: the offer shows CANCELLED only
 * once the cancellation validated and the offer is gone from the ledger. Send an `Idempotency-Key`
 * header: a repeated key replays the first response.
 * 401 without a session · 403 WALLET_NOT_VERIFIED · 404 unknown offer, or not this wallet's ·
 * 409 still awaiting its own approval, no longer open, or a cancellation is already waiting in Xaman.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Offer not found");
  await parseJsonBody(req, CancelOfferBody);
  const deps = mintingDeps();
  const result = await runIdempotent(
    deps.db,
    {
      key: req.headers.get(IDEMPOTENCY_KEY_HEADER),
      scope: session.userId,
      route: "POST /api/offers/:id/cancel-intent",
      request: { offerId: id },
    },
    async () => ({
      status: 201,
      body: await withLedgerErrors(() => requestOfferCancellation(deps, { session, offerId: id })),
    }),
  );
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (result.replayed) headers["Idempotent-Replayed"] = "true";
  return jsonOk(result.body, { requestId, status: result.status, headers });
});
