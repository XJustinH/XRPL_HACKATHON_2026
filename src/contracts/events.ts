/**
 * Shared contract for events, ticket tiers, ticket presentation and discovery.
 *
 * Conventions fixed by the handoff document and used throughout this file:
 *  - XRP amounts are always integer **drops as decimal strings**; never floats.
 *  - Timestamps are UTC ISO-8601 strings; timezone conversion happens in the UI.
 *  - Application IDs are UUIDs. Ledger identifiers (NFTokenID, offer index, tx
 *    hash) are separate string types and must never be substituted for app IDs.
 *
 * Owner note: this module is the event/discovery slice of `src/contracts/`.
 * The barrel export in `src/contracts/index.ts` is reviewed by the schema owner
 * (XRPL-001 / XRPL-002); add new exports there rather than importing deeply.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Primitive branded-ish aliases
 * ------------------------------------------------------------------ */

/** Integer decimal string of XRP drops, e.g. "25000000" = 25 XRP. */
export type Drops = string;
/** XRPL classic address (r...). Presence does not prove control. */
export type XRPLAddress = string;
/** On-ledger unique NFT identifier (64 hex chars). */
export type NFTokenID = string;
/** Validated XRPL transaction hash. */
export type TxHash = string;

export const dropsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, "must be an integer number of drops as a string");

export const xrplAddressSchema = z
  .string()
  .regex(/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/, "must be an XRPL classic address");

export const nftokenIdSchema = z
  .string()
  .regex(/^[0-9A-F]{64}$/i, "must be a 64-character hex NFTokenID");

export const txHashSchema = z
  .string()
  .regex(/^[0-9A-F]{64}$/i, "must be a 64-character hex transaction hash");

export const isoDateTimeSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 timestamp");

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

export const roleSchema = z.enum(["CUSTOMER", "SELLER", "ORGANISER"]);
export type Role = z.infer<typeof roleSchema>;

export const eventStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const offerKindSchema = z.enum(["PRIMARY", "RESALE", "PRIVATE", "GIFT"]);
export type OfferKind = z.infer<typeof offerKindSchema>;

export const offerStateSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "ACCEPTED",
  "CANCELLED",
  "STALE",
]);
export type OfferState = z.infer<typeof offerStateSchema>;

/* ------------------------------------------------------------------ *
 * Ticket tiers (XRPL-016)
 * ------------------------------------------------------------------ */

export const ticketTierInputSchema = z.object({
  name: z.string().trim().min(1, "Tier name is required").max(80),
  priceDrops: dropsSchema,
  totalSupply: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(10_000, "Quantity must be 10,000 or fewer"),
});
export type TicketTierInput = z.infer<typeof ticketTierInputSchema>;

export const ticketTierSchema = ticketTierInputSchema.extend({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  /** Tickets committed on-ledger. Mint commitments make a tier immutable. */
  mintedQuantity: z.number().int().min(0),
  /** Primary-sale units confirmed sold, as reconciled from the ledger. */
  soldQuantity: z.number().int().min(0),
});
export type TicketTier = z.infer<typeof ticketTierSchema>;

/* ------------------------------------------------------------------ *
 * Events (XRPL-015, XRPL-017)
 * ------------------------------------------------------------------ */

export const eventDraftInputSchema = z.object({
  title: z.string().trim().min(3, "Title must be at least 3 characters").max(120),
  description: z.string().trim().max(4_000).default(""),
  startsAt: isoDateTimeSchema,
  venue: z.string().trim().min(1, "Venue is required").max(160),
  city: z.string().trim().min(1, "City is required").max(80),
  artworkUrl: z.string().url("Artwork must be a valid URL").or(z.literal("")).optional(),
});
export type EventDraftInput = z.infer<typeof eventDraftInputSchema>;

/** Patch shape for XRPL-017. Every field optional; server re-validates. */
export const eventPatchInputSchema = eventDraftInputSchema.partial();
export type EventPatchInput = z.infer<typeof eventPatchInputSchema>;

export const eventSchema = z.object({
  id: z.string().uuid(),
  sellerId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  startsAt: isoDateTimeSchema,
  venue: z.string(),
  city: z.string(),
  status: eventStatusSchema,
  artworkUrl: z.string().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  publishedAt: isoDateTimeSchema.nullable(),
});
export type EventRecord = z.infer<typeof eventSchema>;

/* ------------------------------------------------------------------ *
 * Read models returned to the UI
 * ------------------------------------------------------------------ */

export type TicketTierView = {
  id: string;
  eventId: string;
  name: string;
  priceDrops: Drops;
  totalSupply: number;
  mintedQuantity: number;
  soldQuantity: number;
  /** totalSupply - soldQuantity, floored at 0. */
  remaining: number;
  /** True once mint commitments exist; price/quantity become immutable. */
  locked: boolean;
};

export type SellerSummary = {
  id: string;
  displayName: string;
  city: string | null;
  isVerified: boolean;
};

export type EventView = {
  id: string;
  seller: SellerSummary;
  title: string;
  description: string;
  startsAt: string;
  venue: string;
  city: string;
  status: EventStatus;
  artworkUrl: string | null;
  tiers: TicketTierView[];
  createdAt: string;
  updatedAt: string;
};

/**
 * Primary availability, calculated from live inventory.
 *
 * Source of truth is the inventory calculation behind XRPL-020; this view type
 * mirrors it so the UI never recomputes sell-out state from raw tier numbers.
 */
export type EventAvailability = {
  eventId: string;
  totalSupply: number;
  sold: number;
  remaining: number;
  isSoldOut: boolean;
  /** Cheapest live primary ask, or null when nothing is on sale. */
  fromPriceDrops: Drops | null;
  calculatedAt: string;
};

export type EventListItem = {
  event: EventView;
  availability: EventAvailability;
};

/* ------------------------------------------------------------------ *
 * Ticket presentation (XRPL-033, XRPL-034)
 * ------------------------------------------------------------------ */

export type LedgerProof = {
  nftokenId: NFTokenID;
  issuerAddress: XRPLAddress;
  ownerAddress: XRPLAddress;
  mintTxHash: TxHash;
  /** Set once a transfer has been reconciled onto this ticket. */
  lastTransferTxHash: TxHash | null;
  metadataUri: string;
  ledgerIndex: number;
  /** When the owner was last confirmed against the ledger. */
  verifiedAt: string;
  explorerTxUrl: string;
  explorerNftUrl: string;
};

export type TicketView = {
  id: string;
  eventId: string;
  tierId: string;
  serial: number;
  tierName: string;
  priceDrops: Drops;
  event: {
    id: string;
    title: string;
    startsAt: string;
    venue: string;
    city: string;
    artworkUrl: string | null;
    sellerDisplayName: string;
  };
  ledger: LedgerProof;
  checkedInAt: string | null;
  /** True when the signed-in session's wallet currently owns the token. */
  ownedByViewer: boolean;
};

/* ------------------------------------------------------------------ *
 * Resale presentation (XRPL-038)
 * ------------------------------------------------------------------ */

export type ResaleListing = {
  offerId: string;
  offerIndex: string;
  nftokenId: NFTokenID;
  sellerAddress: XRPLAddress;
  amountDrops: Drops;
  kind: OfferKind;
  state: OfferState;
  createTxHash: TxHash;
  createdAt: string;
  ticket: {
    id: string;
    serial: number;
    tierName: string;
    faceValueDrops: Drops;
  };
  event: {
    id: string;
    title: string;
    startsAt: string;
    venue: string;
    city: string;
  };
};

/**
 * Whether the application may publish resale offers for an event.
 *
 * This is an **in-app publication policy only** (XRPL-037). A transferable NFT
 * can always be traded outside this application; the UI must say so rather than
 * implying the restriction is enforced by the ledger.
 */
export type ResaleEligibility = {
  eventId: string;
  isPublicResaleAllowed: boolean;
  reasonCode:
    | "PRIMARY_SOLD_OUT"
    | "PRIMARY_STILL_ON_SALE"
    | "EVENT_NOT_PUBLISHED"
    | "EVENT_FINISHED";
  message: string;
  evaluatedAt: string;
};

/* ------------------------------------------------------------------ *
 * Discovery (XRPL-059, XRPL-089, XRPL-090)
 * ------------------------------------------------------------------ */

export const eventSortSchema = z.enum(["SOONEST", "PRICE_ASC", "RECOMMENDED"]);
export type EventSort = z.infer<typeof eventSortSchema>;

export const eventQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  maxPriceDrops: dropsSchema.optional(),
  sellerId: z.string().uuid().optional(),
  sort: eventSortSchema.default("SOONEST"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type EventQuery = z.infer<typeof eventQuerySchema>;

export type Page<T> = {
  items: T[];
  /** Opaque cursor; never parse this in the UI. */
  nextCursor: string | null;
};

/* ------------------------------------------------------------------ *
 * Profiles (XRPL-055..058, XRPL-087, XRPL-091)
 * ------------------------------------------------------------------ */

export const socialLinkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  url: z.string().url("Must be a valid URL"),
});
export type SocialLink = z.infer<typeof socialLinkSchema>;

export const profileVisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
export type ProfileVisibility = z.infer<typeof profileVisibilitySchema>;

export const sellerProfilePatchSchema = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  bio: z.string().trim().max(1_000).optional(),
  city: z.string().trim().max(80).optional(),
  websiteUrl: z.string().url().or(z.literal("")).optional(),
  socialLinks: z.array(socialLinkSchema).max(6).optional(),
});
export type SellerProfilePatch = z.infer<typeof sellerProfilePatchSchema>;

export type SellerProfile = {
  id: string;
  displayName: string;
  bio: string;
  city: string | null;
  websiteUrl: string | null;
  socialLinks: SocialLink[];
  isVerified: boolean;
  followerCount: number;
  publishedEventCount: number;
  joinedAt: string;
};

export const customerProfilePatchSchema = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  city: z.string().trim().max(80).optional(),
  interests: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  visibility: profileVisibilitySchema.optional(),
  socialLinks: z.array(socialLinkSchema).max(6).optional(),
});
export type CustomerProfilePatch = z.infer<typeof customerProfilePatchSchema>;

export type CustomerProfile = {
  id: string;
  displayName: string;
  city: string | null;
  interests: string[];
  visibility: ProfileVisibility;
  socialLinks: SocialLink[];
  joinedAt: string;
  /** Counts are omitted (null) when a private profile is viewed by a stranger. */
  stats: {
    ticketsOwned: number;
    eventsAttended: number;
    following: number;
  } | null;
};

/* ------------------------------------------------------------------ *
 * Wallet readiness for purchase (XRPL-030)
 * ------------------------------------------------------------------ */

export type WalletReadiness = {
  status: "DISCONNECTED" | "CONNECTED" | "WRONG_NETWORK";
  network: string;
  address: XRPLAddress | null;
  /** Spendable balance in drops, when the ledger could be read. */
  balanceDrops: Drops | null;
  /** True when address is set, network matches and balance covers the ask. */
  canPurchase: boolean;
  blockers: string[];
};

export type PurchaseQuote = {
  eventId: string;
  tierId: string;
  tierName: string;
  priceDrops: Drops;
  /** Network fee estimate supplied by the ledger service; never guessed here. */
  estimatedFeeDrops: Drops | null;
  totalDrops: Drops;
  /** The live primary offer that would be accepted, when one exists. */
  offer: {
    offerId: string;
    offerIndex: string;
    nftokenId: NFTokenID;
    sellerAddress: XRPLAddress;
  } | null;
  availability: EventAvailability;
  wallet: WalletReadiness;
  quotedAt: string;
};

/* ------------------------------------------------------------------ *
 * JSON envelope (handoff §3 "Mandatory contract conventions")
 * ------------------------------------------------------------------ */

export type ApiSuccess<T> = { data: T };
export type ApiFailure = {
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function isApiFailure<T>(body: ApiResponse<T>): body is ApiFailure {
  return typeof body === "object" && body !== null && "error" in body;
}
