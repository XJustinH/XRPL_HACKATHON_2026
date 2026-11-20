import { connection } from "next/server";

import { AppId } from "@/contracts/common";
import { getDb } from "@/lib/db/client";
import { errors, withApiHandler } from "@/lib/http/response";
import { loadXrplConfig } from "@/lib/xrpl/config";
import { renderTicketSvg } from "@/lib/xrpl/tickets/image";
import { findTicketForMetadata } from "@/lib/xrpl/tickets/store";

type Context = { params: Promise<{ id: string }> };

/**
 * GET /api/tickets/:id/image: generated SVG artwork for a ticket NFT (XRPL-023), used as
 * the metadata `image` when the event has no artwork. Public, cross-origin readable,
 * and served with a CSP that blocks scripts even if the SVG is opened directly.
 */
export const GET = withApiHandler<Context>(async (_req, ctx) => {
  await connection();
  const { id } = await ctx.params;
  if (!AppId.safeParse(id).success) throw errors.notFound("Ticket not found");

  const ticket = await findTicketForMetadata(getDb(), id);
  if (!ticket) throw errors.notFound("Ticket not found");

  const svg = renderTicketSvg({
    eventTitle: ticket.event.title,
    tierName: ticket.tier.name,
    serial: ticket.serial,
    startsAt: ticket.event.startsAt,
    venue: ticket.event.venue,
    city: ticket.event.city,
    networkLabel: loadXrplConfig().networkLabel,
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
