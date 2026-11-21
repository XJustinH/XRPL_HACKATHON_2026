import { tierPurchaseStates, type TierPurchaseState } from "./purchase-eligibility";
import type { EventPageReads } from "./server-deps";

/** Offers checked against the ledger per page view before one is shown as it was last recorded. */
const MAX_OFFERS_CONFIRMED = 3;

/**
 * The ticket type a buyer picked, with the offer a purchase would take confirmed against the
 * ledger (XRPL-035).
 *
 * An offer that was taken or withdrawn outside the app is closed by the check and the next one is
 * picked, so the buyer is never shown a ticket that is already gone. After a few closed offers, or
 * when the check itself can't run, the offer is shown as last recorded: buying re-checks it.
 *
 * Returns the tier's state, or null when the event has no such ticket type. Throws when
 * availability can't be read.
 */
export async function selectTierForPurchase(
  reads: Pick<EventPageReads, "availability" | "primaryOffers" | "confirmOffer">,
  input: {
    eventId: string;
    tierId: string | undefined;
    /** The buyer's proven wallet, if any: their own purchase in flight doesn't hide a ticket from them. */
    viewerAddress: string | null;
    hasStarted: boolean;
  },
): Promise<TierPurchaseState | null> {
  for (let confirmed = 0; ; confirmed += 1) {
    const [availability, offers] = await Promise.all([
      reads.availability(input.eventId),
      reads.primaryOffers(input.eventId, input.viewerAddress),
    ]);
    const selected =
      tierPurchaseStates(availability.tiers, offers, {
        isPublished: true,
        hasStarted: input.hasStarted,
      }).find((state) => state.tierId === input.tierId) ?? null;
    if (!selected?.canBuy || !selected.offer || confirmed >= MAX_OFFERS_CONFIRMED) return selected;

    const live = await reads.confirmOffer(selected.offer.offerId).catch((error: unknown) => {
      console.error("[purchase] offer could not be checked against the ledger", error);
      return true;
    });
    if (live) return selected;
  }
}
