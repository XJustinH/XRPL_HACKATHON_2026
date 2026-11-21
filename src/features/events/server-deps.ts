import "server-only";
import type { PrimaryAvailability } from "@/contracts/inventory";
import type { AccountSummary, PrimaryOfferListing } from "@/contracts/xrpl";
import type { ResaleEligibility, ResaleListing } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";
import { listPrimaryOffers } from "@/lib/xrpl/offers/primary";
import { refreshOfferForSale } from "@/lib/xrpl/offers/purchase";
import { mintingDeps } from "@/lib/xrpl/tickets/server";
import { getResalePolicy } from "@/lib/resale-policy/server";
import { getXrplQueryService } from "@/lib/xrpl";

/**
 * The reads the public event page needs from the inventory, ledger and resale
 * services (XRPL-019).
 *
 * Gathered behind one boundary so the page depends on a few small functions
 * rather than on three other agents' module layouts, and so each read can be
 * stubbed in tests. Nothing here signs. Every call is a plain read except
 * `confirmOffer`, which records what the ledger has already decided.
 *
 * These are the *public* reads: a draft's figures are never fetched here. The
 * page has already established that the event is published before calling any
 * of them.
 */
export type EventPageReads = {
  availability(eventId: string): Promise<PrimaryAvailability>;
  /**
   * Live primary offers, cheapest first. One that another buyer is in the middle of buying comes
   * back `purchasePending` (XRPL-035); `viewerAddress` is the reader's own proven wallet, whose
   * own purchase in flight doesn't count.
   */
  primaryOffers(eventId: string, viewerAddress?: string | null): Promise<PrimaryOfferListing[]>;
  /**
   * Settles one offer and checks it against the ledger before it's shown for sale (XRPL-035).
   * False when it can no longer be bought: it has then been closed, so it has left the listing.
   */
  confirmOffer(offerId: string): Promise<boolean>;
  /** The resale rule's verdict and, when it allows resale, the public listings (XRPL-037/038). */
  resale(eventId: string): Promise<{ eligibility: ResaleEligibility; offers: ResaleListing[] }>;
};

export function eventPageReads(): EventPageReads {
  const db = getDb();
  return {
    availability: (eventId) => getPrimaryAvailability(db, eventId),
    primaryOffers: (eventId, viewerAddress) => listPrimaryOffers(db, eventId, { viewerAddress }),
    confirmOffer: async (offerId) => (await refreshOfferForSale(mintingDeps(), offerId)) === "ACTIVE",
    resale: (eventId) => getResalePolicy().listPublicOffers(eventId),
  };
}

/**
 * Ledger reads needed to judge whether a wallet can pay (XRPL-030).
 *
 * Separate from the page reads because these hit the XRPL node rather than the
 * database, and the purchase page must be able to render without them — an
 * unreachable node means "unknown", not "cannot pay".
 */
export type WalletReads = {
  accountInfo(address: string): Promise<AccountSummary>;
  reserves(): Promise<{ baseDrops: string; incrementDrops: string }>;
  feeDrops(): Promise<string>;
  networkLabel(): string;
};

export function walletReads(): WalletReads {
  const ledger = getXrplQueryService();
  return {
    accountInfo: (address) => ledger.getAccountInfo(address),
    reserves: () => ledger.getReserves(),
    feeDrops: () => ledger.getFeeEstimateDrops(),
    networkLabel: () =>
      process.env.NEXT_PUBLIC_XRPL_NETWORK_LABEL ?? "XRPL Testnet",
  };
}
