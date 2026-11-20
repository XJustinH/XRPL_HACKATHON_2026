import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { reconcileEventMappings } from "@/lib/xrpl/tickets/mapping";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/events/:id/mints/reconcile: check the event's NFT-to-ticket mappings against the
 * XRP Ledger (XRPL-026). Records validated ticket mints the app missed and verifies every
 * minted ticket against its mint transaction. Disagreements are reported, never overwritten.
 * 200 { data: MintMappingReport }. Safe to repeat.
 * 401 without a session · 404 unknown event · 403 NOT_EVENT_OWNER · 503 when the ledger is unreachable.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const session = await requireSession(req);
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Event not found");
  const report = await withLedgerErrors(() =>
    reconcileEventMappings(mintingDeps(), { session, eventId: id }),
  );
  return jsonOk(report, { requestId, headers: { "Cache-Control": "no-store" } });
});
