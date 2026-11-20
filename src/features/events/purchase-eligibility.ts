import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { Drops } from "@/contracts";
import type { TierAvailability } from "@/contracts/inventory";

/**
 * Whether a tier can be bought right now, and why not when it cannot (XRPL-019).
 *
 * Pure so the page, the buy control and the tests agree. The rule is deliberately
 * strict: a tier is buyable **only** when a live primary sell offer exists for it
 * on the ledger. Declared supply is not an offer — a seller can define a tier and
 * never mint or list it — so remaining stock alone must not enable a purchase.
 */

export type TierPurchaseState = {
  tierId: string;
  name: string;
  /** Face value of the tier, shown even when nothing is on sale. */
  priceDrops: Drops;
  totalSupply: number;
  sold: number;
  remaining: number;
  /** Purchases submitted to the ledger but not yet validated. */
  pending: number;
  /** The cheapest live offer that a buy action would take, or null. */
  offer: PrimaryOfferListing | null;
  canBuy: boolean;
  /** Why buying is unavailable. Null when it is available. */
  blockedReason:
    | "SOLD_OUT"
    | "NO_LIVE_OFFER"
    | "EVENT_STARTED"
    | "NOT_PUBLISHED"
    | null;
  /** Buyer-facing wording for `blockedReason`. */
  blockedMessage: string | null;
};

const MESSAGES: Record<NonNullable<TierPurchaseState["blockedReason"]>, string> = {
  SOLD_OUT: "Sold out",
  // Stock may exist that the organiser has not minted or listed yet.
  NO_LIVE_OFFER: "Not on sale right now",
  EVENT_STARTED: "This event has already started",
  NOT_PUBLISHED: "This event is not on sale",
};

/** Cheapest live offer for a tier, or null. Offers arrive cheapest-first. */
export function cheapestOfferForTier(
  offers: readonly PrimaryOfferListing[],
  tierId: string,
): PrimaryOfferListing | null {
  let best: PrimaryOfferListing | null = null;
  for (const offer of offers) {
    if (offer.tierId !== tierId) continue;
    if (best === null || BigInt(offer.amountDrops) < BigInt(best.amountDrops)) best = offer;
  }
  return best;
}

export function tierPurchaseState(
  tier: TierAvailability,
  offers: readonly PrimaryOfferListing[],
  context: { isPublished: boolean; hasStarted: boolean },
): TierPurchaseState {
  const offer = cheapestOfferForTier(offers, tier.tierId);

  /*
   * Ordered most-specific first. "Sold out" is more useful than "not on sale"
   * when every unit has gone, and an event that has started cannot be bought
   * into whatever the inventory says.
   */
  let blockedReason: TierPurchaseState["blockedReason"] = null;
  if (!context.isPublished) blockedReason = "NOT_PUBLISHED";
  else if (context.hasStarted) blockedReason = "EVENT_STARTED";
  else if (tier.remaining <= 0) blockedReason = "SOLD_OUT";
  else if (offer === null) blockedReason = "NO_LIVE_OFFER";

  return {
    tierId: tier.tierId,
    name: tier.name,
    priceDrops: tier.priceDrops,
    totalSupply: tier.totalSupply,
    sold: tier.sold,
    remaining: tier.remaining,
    pending: tier.pending,
    offer,
    canBuy: blockedReason === null,
    blockedReason,
    blockedMessage: blockedReason === null ? null : MESSAGES[blockedReason],
  };
}

export function tierPurchaseStates(
  tiers: readonly TierAvailability[],
  offers: readonly PrimaryOfferListing[],
  context: { isPublished: boolean; hasStarted: boolean },
): TierPurchaseState[] {
  return tiers.map((tier) => tierPurchaseState(tier, offers, context));
}
