/**
 * Events, ticket tiers, ticket/resale presentation, discovery and profiles.
 *
 * Primitives (`Drops`, `XrplAddress`, `NFTokenId`, `OfferIndex`, `TxHash`,
 * `IsoDateTime`, `AppId`) and the API envelope live in `./common`; stored-record
 * DTOs and the enums that mirror `prisma/schema.prisma` live in `./entities`.
 * This slice imports both rather than redefining them, so a value accepted here
 * is accepted by the database layer too.
 *
 * Scope boundary: the types below are **request shapes and read models for the
 * UI**. They are derived from the stored DTOs but are not a second source of
 * truth — on-chain ownership comes from the ledger, and primary sell-out state
 * comes from the inventory calculation (XRPL-020).
 */
import { z } from "zod";
import { AppId, Drops, IsoDateTime, NFTokenId, OfferIndex, TxHash, XrplAddress } from "./common";
import { EventStatus, OfferKind, OfferState } from "./entities";

/* ------------------------------------------------------------------ *
 * User-supplied URLs
 * ------------------------------------------------------------------ */

/** Schemes that are safe to put in an `href` or an `img src`. */
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A user-supplied web address, restricted to http and https.
 *
 * `z.url()` alone is **not** sufficient here: it accepts `javascript:`,
 * `data:`, `vbscript:` and `file:` URLs, all of which are valid URLs and none
 * of which are safe to render into an anchor on a public page. A seller's
 * profile link is attacker-controlled content as far as a visitor is concerned.
 *
 * Worth promoting to `./common` if another slice takes user-supplied URLs.
 */
export const HttpUrl = z
  .url("Enter a valid web address")
  .refine((value) => {
    try {
      return SAFE_URL_PROTOCOLS.has(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Links must start with http:// or https://");
export type HttpUrl = z.infer<typeof HttpUrl>;

/** `HttpUrl`, or an empty string meaning "cleared". */
export const OptionalHttpUrl = z.union([HttpUrl, z.literal("")]);

/**
 * Returns a URL only when it is safe to render, otherwise null.
 *
 * Validation on write is the main defence; this is the second one, for values
 * that were stored before the rule existed or written by something other than
 * these forms. Rendering code should never pass a stored URL straight to an
 * `href`.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Ticket tiers (XRPL-016)
 * ------------------------------------------------------------------ */

export const TicketTierInput = z.object({
  name: z.string().trim().min(1, "Tier name is required").max(80),
  description: z.string().trim().max(500).default(""),
  priceDrops: Drops,
  totalSupply: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(10_000, "Quantity must be 10,000 or fewer"),
  sortOrder: z.number().int().min(0).default(0),
});
export type TicketTierInput = z.infer<typeof TicketTierInput>;

/**
 * Tier edits before any mint commitment exists.
 *
 * Once `mintedQuantity > 0` the price and supply are immutable, because minted
 * tickets already carry that commitment on-ledger. The server enforces this;
 * the UI only reflects it via `TicketTierView.locked`.
 */
export const TicketTierPatch = TicketTierInput.partial();
export type TicketTierPatch = z.infer<typeof TicketTierPatch>;

/* ------------------------------------------------------------------ *
 * Events (XRPL-015, XRPL-017)
 * ------------------------------------------------------------------ */

export const EventDraftInput = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().trim().max(4_000).default(""),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime.nullable().default(null),
  venue: z.string().trim().min(1, "Venue is required").max(160),
  city: z.string().trim().min(1, "City is required").max(80),
  artworkUrl: OptionalHttpUrl.optional(),
});
export type EventDraftInput = z.infer<typeof EventDraftInput>;

export const EventPatch = EventDraftInput.partial();
export type EventPatch = z.infer<typeof EventPatch>;

/* ------------------------------------------------------------------ *
 * Read models returned to the UI
 * ------------------------------------------------------------------ */

export type TicketTierView = {
  id: AppId;
  eventId: AppId;
  name: string;
  description: string;
  priceDrops: Drops;
  totalSupply: number;
  mintedQuantity: number;
  /** Primary-sale units confirmed sold, reconciled from the ledger. */
  soldQuantity: number;
  /** `totalSupply - soldQuantity`, floored at 0. */
  remaining: number;
  /** True once mint commitments exist; price and supply become immutable. */
  locked: boolean;
};

export type SellerSummary = {
  id: AppId;
  displayName: string;
  city: string | null;
  isVerified: boolean;
};

export type EventView = {
  id: AppId;
  seller: SellerSummary;
  title: string;
  description: string;
  startsAt: IsoDateTime;
  endsAt: IsoDateTime | null;
  venue: string;
  city: string;
  status: EventStatus;
  artworkUrl: string | null;
  tiers: TicketTierView[];
  publishedAt: IsoDateTime | null;
};

/**
 * Primary availability, calculated from live inventory (XRPL-020).
 *
 * The UI must read sell-out state from here rather than recomputing it from raw
 * tier numbers, because inventory also reconciles against the ledger.
 */
export type EventAvailability = {
  eventId: AppId;
  totalSupply: number;
  sold: number;
  remaining: number;
  isSoldOut: boolean;
  /** Cheapest live primary ask, or null when nothing is on sale. */
  fromPriceDrops: Drops | null;
  calculatedAt: IsoDateTime;
};

export type EventListItem = {
  event: EventView;
  availability: EventAvailability;
};

/* ------------------------------------------------------------------ *
 * Ticket presentation (XRPL-033, XRPL-034)
 * ------------------------------------------------------------------ */

export type LedgerProof = {
  nftokenId: NFTokenId;
  issuerAddress: XrplAddress;
  ownerAddress: XrplAddress;
  mintTxHash: TxHash;
  /** Set once a transfer has been reconciled onto this ticket. */
  lastTransferTxHash: TxHash | null;
  metadataUri: string;
  ledgerIndex: number;
  /** When the owner was last confirmed against the ledger. */
  verifiedAt: IsoDateTime;
  explorerTxUrl: string;
  explorerNftUrl: string;
};

export type TicketView = {
  id: AppId;
  eventId: AppId;
  tierId: AppId;
  serial: number;
  tierName: string;
  priceDrops: Drops;
  event: {
    id: AppId;
    title: string;
    startsAt: IsoDateTime;
    venue: string;
    city: string;
    artworkUrl: string | null;
    sellerDisplayName: string;
  };
  ledger: LedgerProof;
  checkedInAt: IsoDateTime | null;
  /** True when the session's verified wallet currently owns the token. */
  ownedByViewer: boolean;
};

/* ------------------------------------------------------------------ *
 * Resale presentation (XRPL-038)
 * ------------------------------------------------------------------ */

export type ResaleListing = {
  offerId: AppId;
  offerIndex: OfferIndex;
  nftokenId: NFTokenId;
  sellerAddress: XrplAddress;
  amountDrops: Drops;
  kind: OfferKind;
  state: OfferState;
  createTxHash: TxHash;
  createdAt: IsoDateTime;
  ticket: {
    id: AppId;
    serial: number;
    tierName: string;
    faceValueDrops: Drops;
  };
  event: {
    id: AppId;
    title: string;
    startsAt: IsoDateTime;
    venue: string;
    city: string;
  };
};

/**
 * Whether the application may publish resale offers for an event (XRPL-037).
 *
 * This is an **in-app publication policy only**. A transferable NFT can always
 * be traded outside this application, so the UI must present this as a platform
 * rule and never imply the ledger enforces it.
 */
export type ResaleEligibility = {
  eventId: AppId;
  isPublicResaleAllowed: boolean;
  reasonCode:
    | "PRIMARY_SOLD_OUT"
    | "PRIMARY_STILL_ON_SALE"
    | "EVENT_NOT_PUBLISHED"
    | "EVENT_FINISHED";
  message: string;
  evaluatedAt: IsoDateTime;
};

/* ------------------------------------------------------------------ *
 * Discovery (XRPL-059, XRPL-089, XRPL-090)
 * ------------------------------------------------------------------ */

/**
 * A cursor page of results.
 *
 * Matches the shape produced by `pageOf()` in `./common`, which ships the Zod
 * helper but no TypeScript type. Declared here because the event read models
 * need it; worth moving to `./common` if another slice wants it too.
 */
export type Page<T> = { items: T[]; nextCursor: string | null };

export const EventSort = z.enum(["SOONEST", "PRICE_ASC", "RECOMMENDED"]);
export type EventSort = z.infer<typeof EventSort>;

export const EventQuery = z.object({
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  maxPriceDrops: Drops.optional(),
  sellerId: AppId.optional(),
  sort: EventSort.default("SOONEST"),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type EventQuery = z.infer<typeof EventQuery>;

/* ------------------------------------------------------------------ *
 * Profiles (XRPL-055..058, XRPL-087, XRPL-091)
 * ------------------------------------------------------------------ */

export const SocialLink = z.object({
  label: z.string().trim().min(1).max(40),
  url: HttpUrl,
});
export type SocialLink = z.infer<typeof SocialLink>;

export const ProfileVisibility = z.enum(["PUBLIC", "PRIVATE"]);
export type ProfileVisibility = z.infer<typeof ProfileVisibility>;

export const SellerProfilePatch = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  bio: z.string().trim().max(1_000).optional(),
  city: z.string().trim().max(80).optional(),
  websiteUrl: OptionalHttpUrl.optional(),
  /** Profile image. Stored as a URL; media hosting itself is XRPL-071. */
  imageUrl: OptionalHttpUrl.optional(),
  socialLinks: z.array(SocialLink).max(6).optional(),
});
export type SellerProfilePatch = z.infer<typeof SellerProfilePatch>;

export type SellerProfile = {
  id: AppId;
  displayName: string;
  bio: string;
  city: string | null;
  websiteUrl: string | null;
  imageUrl: string | null;
  socialLinks: SocialLink[];
  /**
   * Reserved for a future verification process. Always false today, and the UI
   * must not present it as a trust signal until one exists.
   */
  isVerified: boolean;
  /** Null until follows exist (XRPL-061), so the UI can omit it rather than show 0. */
  followerCount: number | null;
  publishedEventCount: number;
  joinedAt: IsoDateTime;
};

export const CustomerProfilePatch = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  city: z.string().trim().max(80).optional(),
  interests: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  visibility: ProfileVisibility.optional(),
  socialLinks: z.array(SocialLink).max(6).optional(),
});
export type CustomerProfilePatch = z.infer<typeof CustomerProfilePatch>;

export type CustomerProfile = {
  id: AppId;
  displayName: string;
  city: string | null;
  interests: string[];
  visibility: ProfileVisibility;
  socialLinks: SocialLink[];
  joinedAt: IsoDateTime;
  /** Null when a private profile is viewed by someone not permitted to see it. */
  stats: {
    ticketsOwned: number;
    eventsAttended: number;
    following: number;
  } | null;
};

/* ------------------------------------------------------------------ *
 * Wallet readiness and purchase quote (XRPL-030)
 * ------------------------------------------------------------------ */

export type WalletReadiness = {
  status: "DISCONNECTED" | "CONNECTED" | "WRONG_NETWORK";
  network: string;
  address: XrplAddress | null;
  /** Spendable balance in drops, when the ledger could be read. */
  balanceDrops: Drops | null;
  /** True when an address is linked, the network matches and funds cover the ask. */
  canPurchase: boolean;
  blockers: string[];
};

export type PurchaseQuote = {
  eventId: AppId;
  tierId: AppId;
  tierName: string;
  priceDrops: Drops;
  /** Fee estimate from the ledger service; never guessed in the UI. */
  estimatedFeeDrops: Drops | null;
  totalDrops: Drops;
  /** The live primary offer that would be accepted, when one exists. */
  offer: {
    offerId: AppId;
    offerIndex: OfferIndex;
    nftokenId: NFTokenId;
    sellerAddress: XrplAddress;
  } | null;
  availability: EventAvailability;
  wallet: WalletReadiness;
  quotedAt: IsoDateTime;
};

/*
 * `EventStatus`, `OfferKind`, `OfferState` and `UserRole` are deliberately not
 * re-exported here. They belong to `./entities` (mirroring the database), and
 * re-exporting them would make the `export *` in the barrel ambiguous again.
 * Import them from `@/contracts`.
 */
