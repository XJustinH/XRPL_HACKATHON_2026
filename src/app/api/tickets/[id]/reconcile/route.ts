import { AppId } from "@/contracts/common";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { reconcileTicket } from "@/lib/ownership/ticket-sync";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/tickets/:id/reconcile: bring one ticket in step with the XRP Ledger (XRPL-043).
 * Signed-in callers only. Brings the ticket's live offers up to date, closing any the ledger no longer
 * backs (for example, the previous holder's listing after the ticket moved), then reads its owner
 * from a validated ledger and refreshes the app's cache. It only records what the ledger proves, so
 * anyone signed in may trigger it, and repeats are harmless.
 *
 * 200 { data: TicketReconcileResult } · 401 signed out · 404 unknown ticket · 503 ledger unavailable.
 */
export const POST = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");
  const session = await requireSession(req, getDb());

  const result = await withLedgerErrors(() =>
    reconcileTicket(mintingDeps(), { ticketId: id, viewerAddress: session.walletAddress ?? null }),
  );
  return jsonOk(result, { requestId, headers: { "Cache-Control": "no-store" } });
});
