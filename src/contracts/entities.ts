import { z } from "zod";
import { AppId, Drops, IsoDateTime, NFTokenId, OfferIndex, TxHash, XrplAddress } from "./common";

/**
 * Core entity DTOs mirroring prisma/schema.prisma (XRPL-005). Owner: Agent A.
 * These are the public JSON shapes of stored records. Request/response contracts for
 * specific routes live in each domain file (events.ts — C, xrpl.ts — B, checkin.ts — D).
 * Enum values must match the Prisma enums; `src/contracts/entities.test.ts` enforces this.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const UserRole = z.enum(["CUSTOMER", "SELLER", "ORGANISER"]);
export type UserRole = z.infer<typeof UserRole>;

export const XrplNetwork = z.enum(["TESTNET", "DEVNET"]);
export type XrplNetwork = z.infer<typeof XrplNetwork>;

export const EventStatus = z.enum(["DRAFT", "PUBLISHED"]);
export type EventStatus = z.infer<typeof EventStatus>;

export const MintStatus = z.enum(["PENDING", "SUBMITTED", "MINTED", "FAILED"]);
export type MintStatus = z.infer<typeof MintStatus>;

export const SyncStatus = z.enum(["UNSYNCED", "SYNCED", "STALE", "ERROR"]);
export type SyncStatus = z.infer<typeof SyncStatus>;

export const OfferKind = z.enum(["PRIMARY", "RESALE", "PRIVATE", "GIFT"]);
export type OfferKind = z.infer<typeof OfferKind>;

export const OfferState = z.enum([
  "PENDING_SIGNATURE",
  "ACTIVE",
  "ACCEPTED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
  "STALE",
]);
export type OfferState = z.infer<typeof OfferState>;

export const LedgerTxStatus = z.enum(["PENDING", "VALIDATED_SUCCESS", "VALIDATED_FAILURE", "DROPPED"]);
export type LedgerTxStatus = z.infer<typeof LedgerTxStatus>;

export const LedgerTxType = z.enum([
  "NFTokenMint",
  "NFTokenCreateOffer",
  "NFTokenAcceptOffer",
  "NFTokenCancelOffer",
  "Payment",
]);
export type LedgerTxType = z.infer<typeof LedgerTxType>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const UserDto = z.object({
  id: AppId,
  role: UserRole,
  displayName: z.string(),
  onboardedAt: IsoDateTime.nullable(),
});
export type UserDto = z.infer<typeof UserDto>;

export const WalletLinkDto = z.object({
  network: XrplNetwork,
  address: XrplAddress,
  /** null = address recorded but control NOT proven. */
  verifiedAt: IsoDateTime.nullable(),
});
export type WalletLinkDto = z.infer<typeof WalletLinkDto>;

export const EventDto = z.object({
  id: AppId,
  sellerId: AppId,
  title: z.string(),
  description: z.string(),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime.nullable(),
  venue: z.string(),
  city: z.string(),
  /** Null when the seller hasn't set one (allowed values: src/contracts/events.ts). */
  category: z.string().nullable(),
  status: EventStatus,
  artworkUrl: z.string().nullable(),
  publishedAt: IsoDateTime.nullable(),
});
export type EventDto = z.infer<typeof EventDto>;

export const TicketTierDto = z.object({
  id: AppId,
  eventId: AppId,
  name: z.string(),
  description: z.string(),
  priceDrops: Drops,
  totalSupply: z.number().int().positive(),
  mintedQuantity: z.number().int().nonnegative(),
  sortOrder: z.number().int(),
});
export type TicketTierDto = z.infer<typeof TicketTierDto>;

/** Cached view of on-chain ownership. Display only — never use for authorisation. */
export const CachedOwnershipDto = z.object({
  ownerAddress: XrplAddress.nullable(),
  syncStatus: SyncStatus,
  syncedAt: IsoDateTime.nullable(),
  ledgerIndex: z.number().int().nullable(),
});
export type CachedOwnershipDto = z.infer<typeof CachedOwnershipDto>;

export const TicketDto = z.object({
  id: AppId,
  eventId: AppId,
  tierId: AppId,
  serial: z.number().int().positive(),
  nftokenId: NFTokenId.nullable(),
  issuerAddress: XrplAddress.nullable(),
  metadataUri: z.string().nullable(),
  mintStatus: MintStatus,
  mintTxHash: TxHash.nullable(),
  mintedAt: IsoDateTime.nullable(),
  primarySoldAt: IsoDateTime.nullable(),
  cachedOwnership: CachedOwnershipDto,
});
export type TicketDto = z.infer<typeof TicketDto>;

export const NFTOfferDto = z.object({
  id: AppId,
  ticketId: AppId.nullable(),
  nftokenId: NFTokenId,
  offerIndex: OfferIndex.nullable(),
  kind: OfferKind,
  state: OfferState,
  ownerAddress: XrplAddress,
  destinationAddress: XrplAddress.nullable(),
  amountDrops: Drops,
  expiresAt: IsoDateTime.nullable(),
  createTxHash: TxHash.nullable(),
  acceptTxHash: TxHash.nullable(),
  cancelTxHash: TxHash.nullable(),
});
export type NFTOfferDto = z.infer<typeof NFTOfferDto>;

export const LedgerTransactionDto = z.object({
  hash: TxHash.nullable(),
  type: LedgerTxType,
  network: XrplNetwork,
  status: LedgerTxStatus,
  resultCode: z.string().nullable(),
  ledgerIndex: z.number().int().nullable(),
  validatedAt: IsoDateTime.nullable(),
});
export type LedgerTransactionDto = z.infer<typeof LedgerTransactionDto>;

export const CheckInRecordDto = z.object({
  id: AppId,
  ticketId: AppId,
  eventId: AppId,
  organiserId: AppId,
  walletAddress: XrplAddress,
  scannedAt: IsoDateTime,
  verifiedLedgerIndex: z.number().int().nullable(),
});
export type CheckInRecordDto = z.infer<typeof CheckInRecordDto>;

/** A stored event review (XRPL-079). Public review endpoints should omit hidden ones. */
export const ReviewDto = z.object({
  id: AppId,
  eventId: AppId,
  authorId: AppId,
  rating: z.number().int().min(1).max(5),
  body: z.string().max(2000),
  /** The check-in that proves the author attended; null only if the API ever allows unverified reviews. */
  checkInRecordId: AppId.nullable(),
  hiddenAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ReviewDto = z.infer<typeof ReviewDto>;
