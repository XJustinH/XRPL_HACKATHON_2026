import { NFTokenMintFlags } from "xrpl";

import {
  COLLECTIBLE_METADATA_SCHEMA,
  COPYRIGHT_NOTICE,
  type CollectibleNftMetadata,
  type MediaKind,
} from "@/contracts/collectibles";

/**
 * Collectible NFT identity and metadata (XRPL-072/073). See docs/collectibles.md.
 *
 * A collectible is told apart from a ticket three ways: its own taxon, its own memo type, and
 * its own tables. Tickets use a per-event taxon derived from the event ID (`ticketTaxon`), and
 * identity always comes from the app's own mapping, never from the taxon alone.
 */

/** NFTokenTaxon of every collectible NFT. Fixed; the ticket flow never asks for it. */
export const COLLECTIBLE_TAXON = 0xc011ec71;
/** Transferable (holders may resell or gift), not burnable by the issuer, no transfer fee. */
export const COLLECTIBLE_NFT_FLAGS = NFTokenMintFlags.tfTransferable;
/** Memo type on every collectible mint, offer and purchase; the data is the token's app ID. */
export const COLLECTIBLE_MEMO_TYPE = "xrpl-ticketing/collectible";
export const COLLECTIBLE_FAMILY = "XRPL Ticketing Collectibles";

const MAX_DESCRIPTION_LENGTH = 1000;

/** The stable metadata URI written into a collectible NFT. One per edition. */
export function collectibleMetadataUrl(baseUrl: string, tokenId: string): string {
  return `${baseUrl}/api/collectibles/tokens/${encodeURIComponent(tokenId)}/metadata`;
}

export function mediaContentUrl(baseUrl: string, assetId: string): string {
  return `${baseUrl}/api/assets/${encodeURIComponent(assetId)}/content`;
}

export interface CollectibleMetadataInput {
  token: { id: string; edition: number };
  collectible: { id: string; title: string; description: string; editionSize: number; rightsStatement: string };
  seller: { id: string; displayName: string };
  media: { id: string; kind: MediaKind; mimeType: string; sizeBytes: number };
  network: string;
  baseUrl: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Public metadata for one edition: the media, its creator, title, description, edition number
 * and the rights a buyer receives. Nothing about who bought or holds it.
 */
export function buildCollectibleMetadata(input: CollectibleMetadataInput): CollectibleNftMetadata {
  const { token, collectible, seller, media, baseUrl } = input;
  const mediaUrl = mediaContentUrl(baseUrl, media.id);
  const intro = `Digital collectible by ${seller.displayName}: edition ${token.edition} of ${collectible.editionSize}. Not an event ticket.`;
  return {
    schema: COLLECTIBLE_METADATA_SCHEMA,
    nftType: "collectible.v1",
    name: `${collectible.title} #${token.edition}/${collectible.editionSize}`,
    description: truncate(
      collectible.description ? `${intro} ${collectible.description}` : intro,
      MAX_DESCRIPTION_LENGTH,
    ),
    ...(media.kind === "IMAGE" ? { image: mediaUrl } : media.kind === "AUDIO" ? { audio: mediaUrl } : { video: mediaUrl }),
    collection: { name: collectible.title, family: COLLECTIBLE_FAMILY },
    attributes: [
      { trait_type: "Creator", value: seller.displayName },
      { trait_type: "Edition", value: token.edition },
      { trait_type: "Edition size", value: collectible.editionSize },
      { trait_type: "Media", value: media.kind.toLowerCase() },
    ],
    media: { url: mediaUrl, kind: media.kind, mimeType: media.mimeType, sizeBytes: media.sizeBytes },
    creator: {
      sellerId: seller.id,
      name: seller.displayName,
      profileUrl: `${baseUrl}/sellers/${seller.id}`,
    },
    edition: { number: token.edition, of: collectible.editionSize },
    collectible: {
      collectibleId: collectible.id,
      tokenId: token.id,
      network: input.network,
      listingUrl: `${baseUrl}/collectibles/${collectible.id}`,
    },
    rights: {
      statement: collectible.rightsStatement,
      copyrightTransferred: false,
      copyrightNotice: COPYRIGHT_NOTICE,
      grantsEventEntry: false,
    },
  };
}
