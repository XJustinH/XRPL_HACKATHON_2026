import { z } from "zod";

import { AppId, Drops, IsoDateTime, NFTokenId, OfferIndex, TxHash, XrplAddress } from "./common";
import { TransactionRequest } from "./xrpl";

/**
 * Digital collectibles (XRPL-070 to XRPL-075): artist NFTs that are NOT tickets.
 * Safe to import from client code. Not re-exported from `./index`; import this file directly.
 */

// ---------------------------------------------------------------------------
// Media uploads (XRPL-070/071)
// ---------------------------------------------------------------------------

export const MediaKind = z.enum(["IMAGE", "AUDIO", "VIDEO"]);
export type MediaKind = z.infer<typeof MediaKind>;

/** Every media type a collectible may use. SVG and HTML are deliberately absent (they can carry script). */
export const SUPPORTED_MEDIA_TYPES: Readonly<Record<string, { kind: MediaKind; extension: string }>> = {
  "image/png": { kind: "IMAGE", extension: "png" },
  "image/jpeg": { kind: "IMAGE", extension: "jpg" },
  "image/webp": { kind: "IMAGE", extension: "webp" },
  "image/gif": { kind: "IMAGE", extension: "gif" },
  "audio/mpeg": { kind: "AUDIO", extension: "mp3" },
  "audio/wav": { kind: "AUDIO", extension: "wav" },
  "audio/ogg": { kind: "AUDIO", extension: "ogg" },
  "audio/flac": { kind: "AUDIO", extension: "flac" },
  "audio/mp4": { kind: "AUDIO", extension: "m4a" },
  "video/mp4": { kind: "VIDEO", extension: "mp4" },
  "video/webm": { kind: "VIDEO", extension: "webm" },
};

const MB = 1024 * 1024;
/** Largest upload per kind, in bytes. */
export const MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  IMAGE: 10 * MB,
  AUDIO: 25 * MB,
  VIDEO: 50 * MB,
};
export const MEDIA_MAX_BYTES_ANY = Math.max(...Object.values(MEDIA_MAX_BYTES));

/** For the file picker. The server decides from the file's own signature, not from this. */
export const MEDIA_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,audio/*,video/mp4,video/webm,.mp3,.wav,.ogg,.flac,.m4a";
export const MEDIA_SUPPORTED_SUMMARY =
  "Images (PNG, JPEG, WebP, GIF) up to 10 MB · audio (MP3, WAV, OGG, FLAC, M4A) up to 25 MB · video (MP4, WebM) up to 50 MB";

/** Error codes of `POST /api/assets`. */
export const MediaUploadErrorCode = {
  RIGHTS_NOT_CONFIRMED: "RIGHTS_NOT_CONFIRMED",
  NO_FILE: "NO_FILE",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  MEDIA_STORAGE_FAILED: "MEDIA_STORAGE_FAILED",
} as const;

/** What the seller must confirm before any upload is accepted (XRPL-070). */
export const RIGHTS_DECLARATION =
  "I confirm that I own this content or hold the rights needed to offer it as a digital collectible, and that it does not infringe anyone else's rights.";

export const MediaAssetView = z.object({
  id: AppId,
  kind: MediaKind,
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  originalName: z.string(),
  rightsConfirmedAt: IsoDateTime,
  /** Served only for a published collectible, or to the uploader. */
  contentUrl: z.string(),
});
export type MediaAssetView = z.infer<typeof MediaAssetView>;

// ---------------------------------------------------------------------------
// Rights (XRPL-072)
// ---------------------------------------------------------------------------

/** Used when the seller does not write their own statement. */
export const DEFAULT_RIGHTS_STATEMENT =
  "The buyer owns this numbered edition as an NFT and may keep, display, resell or give it away. The buyer may view or play the media for personal, non-commercial use.";

/** Always shown with a listing, whatever the seller's statement says. */
export const COPYRIGHT_NOTICE =
  "Copyright is not transferred automatically. Unless the creator grants more in writing, the creator keeps the copyright and every other right in the work; buying the NFT does not let you copy, publish or sell the content itself.";

/** Collectibles are merchandise, never admission (XRPL-073/075). */
export const NO_ENTRY_NOTICE =
  "A digital collectible is not a ticket. Buying or holding one does not grant entry to any event.";

// ---------------------------------------------------------------------------
// Listings and tokens
// ---------------------------------------------------------------------------

export const CollectibleStatus = z.enum(["DRAFT", "PUBLISHED"]);
export type CollectibleStatus = z.infer<typeof CollectibleStatus>;
export const CollectibleMintStatus = z.enum(["NOT_MINTED", "PENDING", "SUBMITTED", "MINTED", "FAILED"]);
export type CollectibleMintStatus = z.infer<typeof CollectibleMintStatus>;
export const CollectibleOfferStatus = z.enum(["NONE", "PENDING", "ACTIVE", "ACCEPTED", "FAILED", "STALE"]);
export type CollectibleOfferStatus = z.infer<typeof CollectibleOfferStatus>;
export const CollectibleSaleStatus = z.enum(["NONE", "PENDING", "SOLD"]);
export type CollectibleSaleStatus = z.infer<typeof CollectibleSaleStatus>;

export const MAX_EDITION_SIZE = 100;
const PositiveDrops = Drops.refine((v) => v !== "0", "Set a price above 0 XRP");

export const CreateCollectibleBody = z
  .object({
    mediaAssetId: AppId,
    title: z.string().trim().min(1, "Give the collectible a title").max(120),
    description: z.string().trim().max(2000).default(""),
    editionSize: z.number().int().min(1).max(MAX_EDITION_SIZE),
    priceDrops: PositiveDrops,
    /** What buyers receive. Blank uses `DEFAULT_RIGHTS_STATEMENT`. */
    rightsStatement: z.string().trim().max(1000).optional(),
  })
  .strict();
export type CreateCollectibleBody = z.infer<typeof CreateCollectibleBody>;

/**
 * Edits a draft, and publishes it with `status: "PUBLISHED"`. Once published only `priceDrops`
 * may change (it applies to sale listings created afterwards): NFT metadata must stay stable.
 */
export const UpdateCollectibleBody = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    editionSize: z.number().int().min(1).max(MAX_EDITION_SIZE).optional(),
    priceDrops: PositiveDrops.optional(),
    rightsStatement: z.string().trim().min(1).max(1000).optional(),
    status: z.literal("PUBLISHED").optional(),
  })
  .strict();
export type UpdateCollectibleBody = z.infer<typeof UpdateCollectibleBody>;

/** One edition and its NFT. Never names the buyer: who holds an NFT is a ledger fact. */
export const CollectibleTokenView = z.object({
  id: AppId,
  collectibleId: AppId,
  edition: z.number().int().positive(),
  editionSize: z.number().int().positive(),
  metadataUri: z.string(),
  mintStatus: CollectibleMintStatus,
  /** Set only from a validated tesSUCCESS NFTokenMint. */
  nftokenId: NFTokenId.nullable(),
  issuerAddress: XrplAddress.nullable(),
  mintedAt: IsoDateTime.nullable(),
  offerStatus: CollectibleOfferStatus,
  offerIndex: OfferIndex.nullable(),
  offerAmountDrops: Drops.nullable(),
  saleStatus: CollectibleSaleStatus,
  /** Set only from a validated tesSUCCESS NFTokenAcceptOffer. */
  saleTxHash: TxHash.nullable(),
  soldAt: IsoDateTime.nullable(),
  /** A live sell offer exists and nobody has bought it. */
  forSale: z.boolean(),
  nftExplorerUrl: z.string().nullable(),
  mintTxExplorerUrl: z.string().nullable(),
  offerTxExplorerUrl: z.string().nullable(),
  saleTxExplorerUrl: z.string().nullable(),
});
export type CollectibleTokenView = z.infer<typeof CollectibleTokenView>;

export const CollectibleView = z.object({
  id: AppId,
  sellerId: AppId,
  sellerName: z.string(),
  title: z.string(),
  description: z.string(),
  editionSize: z.number().int().positive(),
  priceDrops: Drops,
  rightsStatement: z.string(),
  status: CollectibleStatus,
  publishedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  media: MediaAssetView,
  /** Empty until the collectible is published. */
  tokens: z.array(CollectibleTokenView),
  mintedCount: z.number().int().nonnegative(),
  forSaleCount: z.number().int().nonnegative(),
});
export type CollectibleView = z.infer<typeof CollectibleView>;

export const CollectibleMintResult = z.object({
  token: CollectibleTokenView,
  request: TransactionRequest,
  /** False when the metadata URI is not reachable from the internet (local development). */
  metadataPublic: z.boolean(),
});
export type CollectibleMintResult = z.infer<typeof CollectibleMintResult>;

/** Result of asking the seller's or the buyer's wallet to approve a sale listing or a purchase. */
export const CollectibleRequestResult = z.object({
  token: CollectibleTokenView,
  request: TransactionRequest,
  title: z.string(),
  amountDrops: Drops,
});
export type CollectibleRequestResult = z.infer<typeof CollectibleRequestResult>;

/** A collectible NFT the wallet holds right now, checked on a validated ledger (XRPL-075). */
export const OwnedCollectible = z.object({
  token: CollectibleTokenView,
  collectible: CollectibleView.omit({ tokens: true, mintedCount: true, forSaleCount: true }),
  ownerAddress: XrplAddress,
  /** Validated ledger the ownership was read from, when the node reported it. */
  verifiedLedgerIndex: z.number().int().nullable(),
  verifiedAt: IsoDateTime,
});
export type OwnedCollectible = z.infer<typeof OwnedCollectible>;

// ---------------------------------------------------------------------------
// NFT metadata (XRPL-072)
// ---------------------------------------------------------------------------

export const COLLECTIBLE_METADATA_SCHEMA = "xrpl-ticketing/collectible@1";

/** Public JSON served at a collectible NFT's URI. XLS-24 layout, plus rights and edition blocks. */
export const CollectibleNftMetadata = z.object({
  schema: z.literal(COLLECTIBLE_METADATA_SCHEMA),
  nftType: z.literal("collectible.v1"),
  name: z.string(),
  description: z.string(),
  /** Present for image collectibles. */
  image: z.string().optional(),
  /** Present for audio collectibles. */
  audio: z.string().optional(),
  /** Present for video collectibles. */
  video: z.string().optional(),
  collection: z.object({ name: z.string(), family: z.string() }),
  attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) })),
  media: z.object({ url: z.string(), kind: MediaKind, mimeType: z.string(), sizeBytes: z.number().int() }),
  creator: z.object({ sellerId: AppId, name: z.string(), profileUrl: z.string() }),
  edition: z.object({ number: z.number().int().positive(), of: z.number().int().positive() }),
  collectible: z.object({ collectibleId: AppId, tokenId: AppId, network: z.string(), listingUrl: z.string() }),
  rights: z.object({
    /** What the seller grants buyers. */
    statement: z.string(),
    copyrightTransferred: z.literal(false),
    copyrightNotice: z.string(),
    /** A collectible is never an admission ticket. */
    grantsEventEntry: z.literal(false),
  }),
});
export type CollectibleNftMetadata = z.infer<typeof CollectibleNftMetadata>;
