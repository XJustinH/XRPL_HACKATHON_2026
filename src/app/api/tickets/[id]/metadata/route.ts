import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { getDb } from "@/lib/db/client";
import { errors, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";
import { buildTicketMetadata } from "@/lib/xrpl/tickets/metadata";
import { findTicketForMetadata } from "@/lib/xrpl/tickets/store";
import { publicArtworkUrl, ticketImageUrl, ticketPublicBaseUrl } from "@/lib/xrpl/tickets/urls";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/tickets/:id/metadata: public metadata JSON for a ticket NFT (XRPL-022/023).
 * This URL is what the NFT's on-ledger URI points to.
 *
 * Returns the raw `TicketNftMetadata` object, not the `{ data }` envelope, because
 * wallets and explorers read NFT metadata at the top level. Cross-origin reads are
 * allowed. No attendee information is ever included. 404 for unknown tickets.
 */
export const GET = withApiHandler<Context>(async (_req, ctx) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");

  const ticket = await findTicketForMetadata(getDb(), id);
  if (!ticket?.issuerAddress) throw errors.notFound("Ticket not found");

  const baseUrl = ticketPublicBaseUrl();
  const metadata = buildTicketMetadata({
    ticket: { id: ticket.id, serial: ticket.serial },
    event: ticket.event,
    tier: ticket.tier,
    issuerAddress: ticket.issuerAddress,
    network: loadXrplConfig().network,
    imageUrl: publicArtworkUrl(ticket.event.artworkUrl) ?? ticketImageUrl(baseUrl, ticket.id),
  });

  return Response.json(metadata, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
