import { connection } from "next/server";

import { AppId, IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, parseJsonBody, withApiHandler } from "@/lib/http/response";
import { getResalePolicy } from "@/lib/resale-policy/server";

import { withLedgerErrors } from "../http";
import { runIdempotent } from "../idempotency";
import { mintingDeps } from "../tickets/server";
import { requestHolderOffer, type HolderOfferInput } from "./holder";

type Context = { params: Promise<{ id: string }> };

/**
 * POST handler for a holder's offer route (resale, private sale or gift; XRPL-036/040/041).
 * 201 { data: TicketOfferRequestResult }: the pending offer plus the transaction request to approve
 * in Xaman. Send an `Idempotency-Key` header: a repeated key replays the first response.
 */
export function holderOfferRoute<B>(
  route: string,
  body: { parse: (value: unknown) => B },
  toOffer: (body: B) => HolderOfferInput,
) {
  return withApiHandler<Context>(async (req, ctx, { requestId }) => {
    await connection();
    const session = await requireSession(req);
    const { id } = await ctx.params;
    if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");
    const offer = toOffer(await parseJsonBody(req, body));
    const deps = {
      ...mintingDeps(),
      // The in-app resale price cap (XRPL-095), checked before the holder signs anything.
      resalePrice: (faceValueDrops: string, amountDrops: string) =>
        getResalePolicy().checkResalePrice(faceValueDrops, amountDrops),
    };
    const result = await runIdempotent(
      deps.db,
      {
        key: req.headers.get(IDEMPOTENCY_KEY_HEADER),
        scope: session.userId,
        route,
        request: { ticketId: id, ...offer },
      },
      async () => ({
        status: 201,
        body: await withLedgerErrors(() => requestHolderOffer(deps, { session, ticketId: id, offer })),
      }),
    );
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (result.replayed) headers["Idempotent-Replayed"] = "true";
    return jsonOk(result.body, { requestId, status: result.status, headers });
  });
}
