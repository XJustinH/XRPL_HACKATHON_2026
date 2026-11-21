/**
 * Server-side reads for the transfer screens (XRPL-034, 038, 039, 040, 041). Server-only.
 *  - the holder's open offer for a ticket (ticket page);
 *  - what a visitor may see of one offer (offer page): private sales and gifts only by the wallet they
 *    name, resale offers only while the in-app resale rule lists them (XRPL-037);
 *  - public resale listings, one event's or all of them (resale page), through the same rule.
 */
import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import type { ResaleListing } from "@/contracts/events";
import type { PrismaClient } from "@/generated/prisma/client";
import { getResalePolicy } from "@/lib/resale-policy/server";

import type { OpenOffer } from "./ticket-transfer-panel";

type Db = Pick<PrismaClient, "nFTOffer" | "event">;

/** The holder's live offer (awaiting approval or active) for a ticket, if any. */
export async function getOpenOffer(db: Db, ticketId: string, holderAddress: string): Promise<OpenOffer | null> {
  const offer = await db.nFTOffer.findFirst({
    where: { ticketId, ownerAddress: holderAddress, state: { in: ["PENDING_SIGNATURE", "ACTIVE"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!offer) return null;
  return {
    id: offer.id,
    kind: offer.kind,
    state: offer.state as OpenOffer["state"],
    amountDrops: offer.amountDrops,
    destinationAddress: offer.destinationAddress,
  };
}

export type OfferPageView = {
  id: string;
  kind: "RESALE" | "PRIVATE" | "GIFT";
  state: string;
  amountDrops: string;
  sellerAddress: string;
  destinationAddress: string | null;
  ticket: { id: string; serial: number; tierName: string; faceValueDrops: string };
  event: { id: string; title: string; startsAt: string; venue: string; city: string };
  /** The ticket has been used to enter the event, so it can't change hands. */
  used: boolean;
};

export type OfferPage =
  | { status: "NOT_FOUND" }
  /** A private sale or gift for a different wallet. Nothing about it is shown. */
  | { status: "NOT_FOR_YOU" }
  | { status: "OPEN" | "CLOSED"; offer: OfferPageView };

/** What `viewerAddress` (the session's proven wallet, or null) may see of an offer. */
export async function getOfferPage(db: Db, offerId: string, viewerAddress: string | null): Promise<OfferPage> {
  const row = await db.nFTOffer.findUnique({
    where: { id: offerId },
    include: {
      ticket: {
        include: {
          tier: { select: { name: true, priceDrops: true } },
          event: { select: { id: true, title: true, startsAt: true, venue: true, city: true, status: true } },
          checkIns: { select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!row || !row.ticket || row.kind === "PRIMARY" || row.ticket.event.status !== "PUBLISHED") {
    return { status: "NOT_FOUND" };
  }
  const kind = row.kind;
  if (kind !== "RESALE" && row.destinationAddress !== viewerAddress) return { status: "NOT_FOR_YOU" };

  const view: OfferPageView = {
    id: row.id,
    kind,
    state: row.state,
    amountDrops: row.amountDrops,
    sellerAddress: row.ownerAddress,
    destinationAddress: row.destinationAddress,
    ticket: {
      id: row.ticket.id,
      serial: row.ticket.serial,
      tierName: row.ticket.tier.name,
      faceValueDrops: row.ticket.tier.priceDrops,
    },
    event: {
      id: row.ticket.event.id,
      title: row.ticket.event.title,
      startsAt: row.ticket.event.startsAt.toISOString(),
      venue: row.ticket.event.venue,
      city: row.ticket.event.city,
    },
    used: row.ticket.checkIns.length > 0,
  };
  if (row.state !== "ACTIVE" || view.used) return { status: "CLOSED", offer: view };
  // A resale offer is shown for sale only while the in-app resale rule lists it publicly.
  if (kind === "RESALE" && !(await getResalePolicy().getPublicOffer(row.ticket.eventId, row.id))) {
    return { status: "NOT_FOUND" };
  }
  return { status: "OPEN", offer: view };
}

export type ResaleListings = {
  listings: ResaleListing[];
  /** Set when the listings are one event's: its title and why it may have none. */
  event: { id: string; title: string; message: string } | null;
};

/**
 * Public resale listings, always through the in-app resale rule: one published event's when
 * `eventId` names one, otherwise every upcoming published event's (at most 50 events).
 */
export async function listResaleListings(
  db: Db,
  options: { eventId?: string | null; now?: Date } = {},
): Promise<ResaleListings> {
  const policy = getResalePolicy();
  if (options.eventId) {
    const event = await db.event.findFirst({
      where: { id: options.eventId, status: "PUBLISHED" },
      select: { id: true, title: true },
    });
    if (event) {
      const { eligibility, offers } = await policy.listPublicOffers(event.id);
      // The pages print the limitation notice once themselves, so it's taken out of the rule's message.
      const message = eligibility.message.replace(RESALE_LIMITATION_NOTICE, "").trim();
      return { listings: offers, event: { ...event, message } };
    }
  }
  const events = await db.event.findMany({
    where: { status: "PUBLISHED", startsAt: { gt: options.now ?? new Date() } },
    select: { id: true },
    orderBy: { startsAt: "asc" },
    take: 50,
  });
  const listings: ResaleListing[] = [];
  for (const event of events) listings.push(...(await policy.listPublicOffers(event.id)).offers);
  return { listings, event: null };
}
