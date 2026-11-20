import "server-only";
import type { PrimaryAvailability } from "@/contracts/inventory";
import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { ResaleEligibility } from "@/contracts";
import { getDb } from "@/lib/db/client";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";
import { listPrimaryOffers } from "@/lib/xrpl/offers/primary";
import { getResalePolicy } from "@/lib/resale-policy/server";

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
