import { connection } from "next/server";

import { jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { getWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/wallet/sign-requests/:id: current status of a sign request (XRPL-011).
 * 200 { data: SignRequest }. Poll until the status is SIGNED, REJECTED, EXPIRED or CANCELLED.
 * Only SIGNED with networkMatches=true may be treated as a connected wallet.
 */
export const GET = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  const request = await withLedgerErrors(() => getWalletSignRequests().get(id));
  return jsonOk(request, { requestId, headers: NO_STORE });
});

/**
 * DELETE /api/wallet/sign-requests/:id: withdraw a request the user has not answered.
 * 200 { data: SignRequest }, normally with status CANCELLED. A request that was already
 * answered keeps its status.
 */
export const DELETE = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  const request = await withLedgerErrors(() => getWalletSignRequests().cancel(id));
  return jsonOk(request, { requestId, headers: NO_STORE });
});
