import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { getTicketHistory } from "@/lib/ownership/history";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { resolveTicketOwnership } from "@/lib/xrpl/tickets/ownership";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/tickets/:id/history: a ticket's transfer history (XRPL-043), oldest first. Each entry is
 * PLATFORM (the app's mint or one of its offers, from the validated transaction) or EXTERNAL (the
 * ticket moved outside the app, seen only from the result on the ledger). The current holder is read
 * from a validated ledger first, which also refreshes the app's cache. If it can't be read,
 * `ownerVerified` is false and the history ends at the last recorded step.
 *
 * Public, like the ticket's ownership: it shows only what is on the public ledger.
 * 200 { data: TicketHistory } · 404 unknown ticket.
 */
export const GET = withApiHandler<Context>(async (_req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");
  const deps = mintingDeps();

  const ownership = await withLedgerErrors(() => resolveTicketOwnership(deps, { ticketId: id }));
  const history = await getTicketHistory(deps, id, ownership);
  return jsonOk(history, { requestId, headers: { "Cache-Control": "no-store" } });
});
