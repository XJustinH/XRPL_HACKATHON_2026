import "server-only";
import type { PrimaryAvailability } from "@/contracts/inventory";
import type { AccountSummary, PrimaryOfferListing } from "@/contracts/xrpl";
import type { ResaleEligibility } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";
import { listPrimaryOffers } from "@/lib/xrpl/offers/primary";
import { getResalePolicy } from "@/lib/resale-policy/server";
import { getXrplQueryService } from "@/lib/xrpl";

/**
 * The reads the public event page needs from the inventory, ledger and resale
 * services (XRPL-019).
 *
 * Gathered behind one boundary so the page depends on three small functions
 * rather than on three other agents' module layouts, and so each read can be
 * stubbed in tests. Every call is a plain read — nothing here writes or signs.
 *
 * These are the *public* reads: no session is involved, so a draft's figures are
 * never fetched here. The page has already established that the event is
 * published before calling any of them.
 */
export type EventPageReads = {
  availability(eventId: string): Promise<PrimaryAvailability>;
  primaryOffers(eventId: string): Promise<PrimaryOfferListing[]>;
  resaleEligibility(eventId: string): Promise<ResaleEligibility>;
};

export function eventPageReads(): EventPageReads {
  const db = getDb();
  return {
    availability: (eventId) => getPrimaryAvailability(db, eventId),
    primaryOffers: (eventId) => listPrimaryOffers(db, eventId),
    resaleEligibility: (eventId) => getResalePolicy().getEligibility(eventId),
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
