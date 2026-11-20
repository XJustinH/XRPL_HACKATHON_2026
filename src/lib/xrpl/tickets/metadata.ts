import { convertStringToHex, NFTokenMintFlags } from "xrpl";

import type { XrplNetwork } from "@/contracts/entities";
import { TICKET_METADATA_SCHEMA, type TicketNftMetadata } from "@/contracts/xrpl";

import { XrplServiceError } from "../errors";

/**
 * Ticket NFT identity rules (XRPL-022). See docs/xrpl/ticket-nft.md.
 *
 * - Transferable, so holders can resell or gift the ticket (XRPL-036/040/041).
 * - Not burnable by the issuer: a seller cannot destroy a ticket someone else holds.
 * - No transfer fee for now; royalties are a separate P2 spike (XRPL-094).
 */
export const TICKET_NFT_FLAGS = NFTokenMintFlags.tfTransferable;

/** "Family" shown by wallets and explorers for every ticket collection. */
export const TICKET_COLLECTION_FAMILY = "XRPL Ticketing";

/** NFTokenMint allows at most 256 bytes of URI. */
export const MAX_NFT_URI_BYTES = 256;

const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * NFTokenTaxon for every ticket of one event, so an issuer's tickets can be grouped
 * per event on the ledger. Derived from the event UUID: stable and needs no storage.
 */
export function ticketTaxon(eventId: string): number {
  const hex = eventId.replace(/-/g, "").slice(0, 8);
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
    throw new XrplServiceError("INVALID_INPUT", "Event ID must be a UUID to derive a ticket taxon");
  }
  return Number.parseInt(hex, 16) >>> 0;
}

/** Hex-encodes a metadata URI for NFTokenMint.URI, refusing anything over the ledger's limit. */
export function encodeNftUri(uri: string): string {
  const bytes = new TextEncoder().encode(uri).length;
  if (bytes === 0 || bytes > MAX_NFT_URI_BYTES) {
    throw new XrplServiceError("INVALID_INPUT", `NFT URI must be 1-${MAX_NFT_URI_BYTES} bytes, got ${bytes}`);
  }
  return convertStringToHex(uri);
}

export interface TicketMetadataInput {
  ticket: { id: string; serial: number };
  event: {
    id: string;
    title: string;
    description: string;
    startsAt: Date;
    endsAt: Date | null;
    venue: string;
    city: string;
  };
  tier: { id: string; name: string; priceDrops: string };
  issuerAddress: string;
  network: XrplNetwork;
  /** Public image URL: the event artwork, or the generated ticket image (XRPL-023). */
  imageUrl: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Builds the public metadata for one ticket. Only event, tier and ticket facts go in:
 * nothing about who bought or holds the ticket.
 */
export function buildTicketMetadata(input: TicketMetadataInput): TicketNftMetadata {
  const { ticket, event, tier } = input;
  const startsAt = event.startsAt.toISOString();
  const intro = `Admission ticket NFT for ${event.title} at ${event.venue}, ${event.city}.`;
  return {
    schema: TICKET_METADATA_SCHEMA,
    nftType: "ticket.v1",
    name: `${event.title} — ${tier.name} #${ticket.serial}`,
    description: truncate(
      event.description ? `${intro} ${event.description}` : intro,
      MAX_DESCRIPTION_LENGTH,
    ),
    image: input.imageUrl,
    collection: { name: event.title, family: TICKET_COLLECTION_FAMILY },
    attributes: [
      { trait_type: "Event", value: event.title },
      { trait_type: "Tier", value: tier.name },
      { trait_type: "Serial", value: ticket.serial },
      { trait_type: "Venue", value: event.venue },
      { trait_type: "City", value: event.city },
      { trait_type: "Starts", value: startsAt },
    ],
    ticket: {
      ticketId: ticket.id,
      eventId: event.id,
      tierId: tier.id,
      serial: ticket.serial,
      issuer: input.issuerAddress,
      network: input.network,
    },
    event: {
      title: event.title,
      startsAt,
      endsAt: event.endsAt ? event.endsAt.toISOString() : null,
      venue: event.venue,
      city: event.city,
    },
    tier: { name: tier.name, priceDrops: tier.priceDrops },
  };
}
