import type {
  CheckInRecord,
  Event,
  LedgerTransaction,
  NFTOffer,
  TicketNFT,
  TicketTier,
  User,
  WalletLink,
} from "@/generated/prisma/client";
import type {
  CheckInRecordDto,
  EventDto,
  LedgerTransactionDto,
  NFTOfferDto,
  TicketDto,
  TicketTierDto,
  UserDto,
  WalletLinkDto,
} from "@/contracts/entities";

/** Map stored rows to public DTOs (src/contracts/entities.ts). Dates become UTC ISO strings. */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  role: u.role,
  displayName: u.displayName,
  onboardedAt: iso(u.onboardedAt),
});

export const toWalletLinkDto = (w: WalletLink): WalletLinkDto => ({
  network: w.network,
  address: w.address,
  verifiedAt: iso(w.verifiedAt),
});

export const toEventDto = (e: Event): EventDto => ({
  id: e.id,
  sellerId: e.sellerId,
  title: e.title,
  description: e.description,
  startsAt: e.startsAt.toISOString(),
  endsAt: iso(e.endsAt),
  venue: e.venue,
  city: e.city,
  category: e.category,
  status: e.status,
  artworkUrl: e.artworkUrl,
  publishedAt: iso(e.publishedAt),
});

export const toTicketTierDto = (t: TicketTier): TicketTierDto => ({
  id: t.id,
  eventId: t.eventId,
  name: t.name,
  description: t.description,
  priceDrops: t.priceDrops,
  totalSupply: t.totalSupply,
  mintedQuantity: t.mintedQuantity,
  sortOrder: t.sortOrder,
});

export const toTicketDto = (t: TicketNFT): TicketDto => ({
  id: t.id,
  eventId: t.eventId,
  tierId: t.tierId,
  serial: t.serial,
  nftokenId: t.nftokenId,
  issuerAddress: t.issuerAddress,
  metadataUri: t.metadataUri,
  mintStatus: t.mintStatus,
  mintTxHash: t.mintTxHash,
  mintedAt: iso(t.mintedAt),
  primarySoldAt: iso(t.primarySoldAt),
  cachedOwnership: {
    ownerAddress: t.cachedOwnerAddress,
    syncStatus: t.ownerSyncStatus,
    syncedAt: iso(t.ownerSyncedAt),
    ledgerIndex: t.ownerSyncLedgerIndex,
  },
});

export const toNFTOfferDto = (o: NFTOffer): NFTOfferDto => ({
  id: o.id,
  ticketId: o.ticketId,
  nftokenId: o.nftokenId,
  offerIndex: o.offerIndex,
  kind: o.kind,
  state: o.state,
  ownerAddress: o.ownerAddress,
  destinationAddress: o.destinationAddress,
  amountDrops: o.amountDrops,
  expiresAt: iso(o.expiresAt),
  createTxHash: o.createTxHash,
  acceptTxHash: o.acceptTxHash,
  cancelTxHash: o.cancelTxHash,
});

export const toLedgerTransactionDto = (t: LedgerTransaction): LedgerTransactionDto => ({
  hash: t.hash,
  type: t.type,
  network: t.network,
  status: t.status,
  resultCode: t.resultCode,
  ledgerIndex: t.ledgerIndex,
  validatedAt: iso(t.validatedAt),
});

export const toCheckInRecordDto = (c: CheckInRecord): CheckInRecordDto => ({
  id: c.id,
  ticketId: c.ticketId,
  eventId: c.eventId,
  organiserId: c.organiserId,
  walletAddress: c.walletAddress,
  scannedAt: c.scannedAt.toISOString(),
  verifiedLedgerIndex: c.verifiedLedgerIndex,
});
