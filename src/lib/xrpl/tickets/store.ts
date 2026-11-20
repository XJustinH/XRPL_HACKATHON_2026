import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import { errors } from "@/lib/http/response";

import { ticketMetadataUrl } from "./urls";

/**
 * Ticket records for minting (XRPL-023/024). Server-only; uses Agent A's schema through
 * the shared Prisma client. No schema changes: every column used here exists already.
 */

export interface CreatePendingTicketInput {
  eventId: string;
  tierId: string;
  /** Seller wallet expected to sign the mint. Replaced by the validated tx's Account later. */
  issuerAddress: string;
  /** Public base URL for the metadata URI (`ticketPublicBaseUrl()`). */
  baseUrl: string;
}

/**
 * Reserves the next ticket in a tier for minting and stores its metadata URI. A ticket
 * whose earlier mint failed is reused first (it never produced an NFT), so serials stay
 * compact. Tickets that are PENDING, SUBMITTED or MINTED count against the tier's supply.
 *
 * 404 if the tier is not part of the event; 409 when the tier is fully allocated.
 *
 * Reservations for a tier run one at a time (the tier row is locked for the transaction),
 * so concurrent requests can never take the same failed ticket twice or reserve beyond
 * the tier's supply (XRPL-025). The (tierId, serial) unique index is a second guard.
 */
export async function createPendingTicket(db: PrismaClient, input: CreatePendingTicketInput) {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; totalSupply: number }>>`
      SELECT "id", "totalSupply" FROM "TicketTier"
      WHERE "id" = ${input.tierId}::uuid AND "eventId" = ${input.eventId}::uuid
      FOR UPDATE`;
    const tier = locked[0];
    if (!tier) throw errors.notFound("Ticket tier not found for this event");

    const failed = await tx.ticketNFT.findFirst({
      where: { tierId: tier.id, mintStatus: "FAILED", nftokenId: null },
      orderBy: { serial: "asc" },
      select: { id: true },
    });
    if (failed) {
      return tx.ticketNFT.update({
        where: { id: failed.id },
        data: {
          mintStatus: "PENDING",
          issuerAddress: input.issuerAddress,
          metadataUri: ticketMetadataUrl(input.baseUrl, failed.id),
          mintTxHash: null,
          mintedAt: null,
        },
      });
    }

    const allocated = await tx.ticketNFT.count({ where: { tierId: tier.id, mintStatus: { not: "FAILED" } } });
    if (allocated >= tier.totalSupply) {
      throw errors.conflict(
        `All ${tier.totalSupply} tickets in this tier are already minted or being minted`,
      );
    }

    const { _max } = await tx.ticketNFT.aggregate({ where: { tierId: tier.id }, _max: { serial: true } });
    const id = randomUUID();
    return tx.ticketNFT.create({
      data: {
        id,
        eventId: input.eventId,
        tierId: tier.id,
        serial: (_max.serial ?? 0) + 1,
        issuerAddress: input.issuerAddress,
        metadataUri: ticketMetadataUrl(input.baseUrl, id),
        mintStatus: "PENDING",
      },
    });
  });
}

/** Everything the public metadata and image routes need for one ticket, or null. */
export async function findTicketForMetadata(db: PrismaClient, ticketId: string) {
  return db.ticketNFT.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      serial: true,
      issuerAddress: true,
      event: {
        select: {
          id: true,
          title: true,
          description: true,
          startsAt: true,
          endsAt: true,
          venue: true,
          city: true,
          artworkUrl: true,
        },
      },
      tier: { select: { id: true, name: true, priceDrops: true } },
    },
  });
}

export type TicketForMetadata = NonNullable<Awaited<ReturnType<typeof findTicketForMetadata>>>;
