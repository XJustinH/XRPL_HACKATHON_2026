/**
 * Database adapters for the resale policy (XRPL-037).
 *
 * `PrismaResaleOffers` reads the app's offer mirror (`NFTOffer`), which Agent B's resale flow
 * (XRPL-036) writes once NFTokenCreateOffer is validated. It only returns offers that are
 * RESALE, ACTIVE, public (no Destination) and have a validated create transaction. It does not
 * re-read the ledger: before accepting a purchase, Agent B's accept route must re-check the live
 * offer on XRPL (handoff §3). Agent B can replace this with their own `OfferPort` at any time.
 */
import type { ResaleListing } from "@/contracts/events";
import type { PrismaClient } from "@/generated/prisma/client";
import type { OfferPort } from "@/features/integration/ports";
import type { PolicyEvent } from "./resale-policy";

export function prismaPolicyEvents(db: Pick<PrismaClient, "event">) {
  return {
    async getEvent(eventId: string): Promise<PolicyEvent | null> {
      const e = await db.event.findUnique({
        where: { id: eventId },
        select: { id: true, status: true, startsAt: true, endsAt: true },
      });
      return e ? { id: e.id, status: e.status, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt?.toISOString() ?? null } : null;
    },
  };
}

export class PrismaResaleOffers implements Pick<OfferPort, "listResaleOffers"> {
  constructor(private readonly db: Pick<PrismaClient, "nFTOffer">) {}

  /** Live public resale offers for an event, cheapest first. */
  async listResaleOffers(eventId: string): Promise<ResaleListing[]> {
    const rows = await this.db.nFTOffer.findMany({
      where: {
        kind: "RESALE",
        state: "ACTIVE",
        destinationAddress: null,
        offerIndex: { not: null },
        createTxHash: { not: null },
        ticket: { eventId },
      },
      select: {
        id: true,
        offerIndex: true,
        nftokenId: true,
        ownerAddress: true,
        amountDrops: true,
        kind: true,
        state: true,
        createTxHash: true,
        createdAt: true,
        ticket: {
          select: {
            id: true,
            serial: true,
            tier: { select: { name: true, priceDrops: true } },
            event: { select: { id: true, title: true, startsAt: true, venue: true, city: true } },
          },
        },
      },
    });

    return rows
      .filter((r) => r.ticket && r.offerIndex && r.createTxHash)
      .map(
        (r): ResaleListing => ({
          offerId: r.id,
          offerIndex: r.offerIndex!,
          nftokenId: r.nftokenId,
          sellerAddress: r.ownerAddress,
          amountDrops: r.amountDrops,
          kind: r.kind,
          state: r.state,
          createTxHash: r.createTxHash!,
          createdAt: r.createdAt.toISOString(),
          ticket: {
            id: r.ticket!.id,
            serial: r.ticket!.serial,
            tierName: r.ticket!.tier.name,
            faceValueDrops: r.ticket!.tier.priceDrops,
          },
          event: {
            id: r.ticket!.event.id,
            title: r.ticket!.event.title,
            startsAt: r.ticket!.event.startsAt.toISOString(),
            venue: r.ticket!.event.venue,
            city: r.ticket!.event.city,
          },
        }),
      )
      .sort((a, b) => {
        const d = BigInt(a.amountDrops) - BigInt(b.amountDrops);
        return d < BigInt(0) ? -1 : d > BigInt(0) ? 1 : a.createdAt.localeCompare(b.createdAt);
      });
  }
}
