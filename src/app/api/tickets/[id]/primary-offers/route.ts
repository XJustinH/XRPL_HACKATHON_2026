import { connection } from "next/server";

import { AppId, IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { CreatePrimaryOfferBody } from "@/contracts/xrpl";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { runIdempotent } from "@/lib/xrpl/idempotency";
import { requestPrimaryOffer } from "@/lib/xrpl/offers/primary";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/tickets/:id/primary-offers: the event's owner lists a minted ticket for sale at its
 * tier price (XRPL-029). Body `{}`. 201 { data: PrimaryOfferRequestResult }: the pending offer plus
 * a transaction request to approve in Xaman (an `NFTokenCreateOffer` sell offer).
 * Send an `Idempotency-Key` header: a repeated key replays the first response.
 * 401 without a session · 404 unknown ticket · 403 NOT_EVENT_OWNER / WALLET_NOT_VERIFIED ·
 * 409 not minted, already sold, already listed, no price, or the wallet does not hold the NFT.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");
  await parseJsonBody(req, CreatePrimaryOfferBody);
  const deps = mintingDeps();
  const result = await runIdempotent(
    deps.db,
    {
      key: req.headers.get(IDEMPOTENCY_KEY_HEADER),
      scope: session.userId,
      route: "POST /api/tickets/:id/primary-offers",
      request: { ticketId: id },
    },
    async () => ({
      status: 201,
      body: await withLedgerErrors(() => requestPrimaryOffer(deps, { session, ticketId: id })),
    }),
  );
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (result.replayed) headers["Idempotent-Replayed"] = "true";
  return jsonOk(result.body, { requestId, status: result.status, headers });
});
