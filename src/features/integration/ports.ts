/**
 * Integration boundary for everything the event/discovery UI consumes but does
 * not own.
 *
 * Each port below is the typed seam for work tracked under another issue. The
 * UI and the route handlers in `src/app/api/` depend **only** on these
 * interfaces, so the in-memory stubs in `./stub` can be replaced with the real
 * implementations without touching any page or component.
 *
 * Replacement map (see the handoff document for the full dependency table):
 *   SessionPort       <- XRPL-010 onboarding, XRPL-012 wallet session, XRPL-013 roles
 *   EventStorePort    <- XRPL-005 core schema (events, tiers, tickets)
 *   InventoryPort     <- XRPL-020 live primary sell-out calculation
 *   LedgerReadPort    <- XRPL-007 read service, XRPL-026 mapping, XRPL-028 ownership
 *   WalletPort        <- XRPL-011 connect/disconnect, XRPL-014 approval + status
 *   OfferPort         <- XRPL-029 primary offers, XRPL-036 resale offers
 *   ResalePolicyPort  <- XRPL-037 in-app sell-out eligibility policy
 *   SocialPort        <- XRPL-061 follows, XRPL-062 wishlist (store side)
 *   AttendancePort    <- XRPL-047 atomic check-in record (read side only)
 */
import type {
  CustomerProfile,
  CustomerProfilePatch,
  Drops,
  EventAvailability,
  EventDraftInput,
  EventPatch,
  EventQuery,
  EventStatus,
  EventView,
  LedgerProof,
  NFTokenId,
  OfferIndex,
  Page,
  ResaleEligibility,
  ResaleListing,
  SellerProfile,
  SellerProfilePatch,
  TicketTierInput,
  TicketTierPatch,
  TicketView,
  UserRole,
  WalletReadiness,
  XrplAddress,
} from "@/contracts";

/* ------------------------------------------------------------------ */

export type Session = {
  userId: string;
  displayName: string;
  role: UserRole;
  /** Verified XRPL address bound to this session, if wallet control was proven. */
  walletAddress: XrplAddress | null;
};

export interface SessionPort {
  /** Current session, or null when unauthenticated. */
  getSession(): Promise<Session | null>;
  /** Switches the active demo persona. Removed once real auth lands. */
  setSession(userId: string | null): Promise<Session | null>;
  listPersonas(): Promise<Session[]>;
}

/* ------------------------------------------------------------------ */

export interface EventStorePort {
  listEvents(query: EventQuery): Promise<Page<EventView>>;
  getEvent(eventId: string): Promise<EventView | null>;
  listSellerEvents(sellerId: string, status?: EventStatus): Promise<EventView[]>;
  createDraft(sellerId: string, input: EventDraftInput): Promise<EventView>;
  updateEvent(eventId: string, input: EventPatch): Promise<EventView>;
  publishEvent(eventId: string): Promise<EventView>;
  unpublishEvent(eventId: string): Promise<EventView>;
  addTier(eventId: string, input: TicketTierInput): Promise<EventView>;
  updateTier(
    eventId: string,
    tierId: string,
    input: TicketTierPatch,
  ): Promise<EventView>;
  removeTier(eventId: string, tierId: string): Promise<EventView>;
  listCities(): Promise<string[]>;
}

/* ------------------------------------------------------------------ */

export interface InventoryPort {
  getAvailability(eventId: string): Promise<EventAvailability>;
  getAvailabilityMany(eventIds: string[]): Promise<Map<string, EventAvailability>>;
}

/* ------------------------------------------------------------------ */

export interface LedgerReadPort {
  /** Current on-chain owner of a token. */
  getOwner(nftokenId: NFTokenId): Promise<XrplAddress | null>;
  /** Tickets whose reconciled owner is this address. */
  listTicketsForOwner(address: XrplAddress): Promise<TicketView[]>;
  getTicket(ticketId: string): Promise<TicketView | null>;
  getLedgerProof(nftokenId: NFTokenId): Promise<LedgerProof | null>;
  /** Current network fee estimate in drops, or null when unavailable. */
  getFeeEstimateDrops(): Promise<Drops | null>;
}

/* ------------------------------------------------------------------ */

export interface WalletPort {
  getReadiness(requiredDrops?: Drops): Promise<WalletReadiness>;
  connect(address?: XrplAddress): Promise<WalletReadiness>;
  disconnect(): Promise<WalletReadiness>;
}

/* ------------------------------------------------------------------ */

export type PrimaryOffer = {
  offerId: string;
  offerIndex: OfferIndex;
  nftokenId: NFTokenId;
  sellerAddress: XrplAddress;
  amountDrops: Drops;
  tierId: string;
};

export interface OfferPort {
  /** Live primary sell offers for an event, cheapest first. */
  listPrimaryOffers(eventId: string): Promise<PrimaryOffer[]>;
  /** Live, valid resale offers. Publication eligibility is decided separately. */
  listResaleOffers(eventId: string): Promise<ResaleListing[]>;
  listAllResaleOffers(): Promise<ResaleListing[]>;
}

/* ------------------------------------------------------------------ */

export interface ResalePolicyPort {
  getEligibility(eventId: string): Promise<ResaleEligibility>;
}

/* ------------------------------------------------------------------ */

export interface SocialPort {
  listFollowedSellerIds(userId: string): Promise<string[]>;
  follow(userId: string, sellerId: string): Promise<void>;
  unfollow(userId: string, sellerId: string): Promise<void>;
  listWishlistEventIds(userId: string): Promise<string[]>;
  addToWishlist(userId: string, eventId: string): Promise<void>;
  removeFromWishlist(userId: string, eventId: string): Promise<void>;
  getSellerProfile(sellerId: string): Promise<SellerProfile | null>;
  updateSellerProfile(sellerId: string, patch: SellerProfilePatch): Promise<SellerProfile>;
  getCustomerProfile(
    userId: string,
    viewerId: string | null,
  ): Promise<CustomerProfile | null>;
  updateCustomerProfile(
    userId: string,
    patch: CustomerProfilePatch,
  ): Promise<CustomerProfile>;
}

/* ------------------------------------------------------------------ */

export interface AttendancePort {
  /** Event IDs the user has a confirmed check-in record for. */
  listAttendedEventIds(userId: string): Promise<string[]>;
}

/* ------------------------------------------------------------------ */

export type Backend = {
  session: SessionPort;
  events: EventStorePort;
  inventory: InventoryPort;
  ledger: LedgerReadPort;
  wallet: WalletPort;
  offers: OfferPort;
  resalePolicy: ResalePolicyPort;
  social: SocialPort;
  attendance: AttendancePort;
};
