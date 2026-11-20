import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { getRequestSession } from "@/lib/auth/session";
import { errors, jsonOk, withApiHandler } from "@/lib/http/response";
import { withLedgerErrors } from "@/lib/xrpl/http";
import { resolveTicketOwnership } from "@/lib/xrpl/tickets/ownership";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/tickets/:id/ownership: who holds the ticket's NFT now, read from a validated ledger
 * (XRPL-028). 200 { data: TicketOwnership }: VERIFIED with the owner, or PENDING when it can't be
 * verified (never treat that as owned), NOT_MINTED or BURNED. `changed` flags a sale or transfer
 * since the last check; `ownedByViewer` compares with the session's proven wallet.
 * Refreshes the ticket's cached owner. 404 for an unknown ticket.
 */
export const GET = withApiHandler<Context>(async (req, ctx, { requestId }) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");
  const session = await getRequestSession(req);
  const ownership = await withLedgerErrors(() =>
    resolveTicketOwnership(mintingDeps(), { ticketId: id, viewerAddress: session?.walletAddress ?? null }),
  );
  return jsonOk(ownership, { requestId, headers: { "Cache-Control": "no-store" } });
});
