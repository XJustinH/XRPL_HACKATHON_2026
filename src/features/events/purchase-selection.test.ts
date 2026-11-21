import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrimaryAvailability, TierAvailability } from "@/contracts/inventory";
import type { PrimaryOfferListing } from "@/contracts/xrpl";

import { selectTierForPurchase } from "./purchase-selection";

/** XRPL-035: the purchase page confirms the ticket it shows against the ledger, and moves on from a dead one. */

const tier = (overrides: Partial<TierAvailability> = {}): TierAvailability => ({
  tierId: "tier-1",
  name: "GA",
  priceDrops: "25000000",
  totalSupply: 10,
  sold: 0,
  remaining: 10,
  pending: 0,
  fromPriceDrops: "25000000",
  ...overrides,
});

const offer = (serial: number, overrides: Partial<PrimaryOfferListing> = {}): PrimaryOfferListing => ({
  offerId: `offer-${serial}`,
  offerIndex: "A".repeat(64),
  nftokenId: "B".repeat(64),
  sellerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
  amountDrops: "25000000",
  tierId: "tier-1",
  tierName: "GA",
  ticketId: `ticket-${serial}`,
  serial,
  expiresAt: null,
  purchasePending: false,
  ...overrides,
});

const availability = (tiers: TierAvailability[]): PrimaryAvailability =>
  ({ eventId: "event-1", tiers }) as PrimaryAvailability;

/** Reads over a list of offers; an offer `confirmOffer` finds dead leaves the list, as on the server. */
function reads(listed: PrimaryOfferListing[], dead: string[] = []) {
  let offers = [...listed];
  return {
    availability: vi.fn(async () => availability([tier()])),
    primaryOffers: vi.fn(async () => offers),
    confirmOffer: vi.fn(async (offerId: string) => {
      if (!dead.includes(offerId)) return true;
      offers = offers.filter((o) => o.offerId !== offerId);
      return false;
    }),
  };
}

const INPUT = { eventId: "event-1", tierId: "tier-1", viewerAddress: "rBuyer", hasStarted: false };

describe("selectTierForPurchase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms the offer it is about to show, once, and shows it when it is live", async () => {
    const r = reads([offer(1), offer(2)]);

    const selected = await selectTierForPurchase(r, INPUT);
    expect(selected).toMatchObject({ canBuy: true, offer: { offerId: "offer-1" } });
    expect(r.confirmOffer).toHaveBeenCalledTimes(1);
    expect(r.confirmOffer).toHaveBeenCalledWith("offer-1");
    expect(r.primaryOffers).toHaveBeenCalledWith("event-1", "rBuyer");
  });

  it("moves on to the next ticket when the first one turns out to be gone", async () => {
    const r = reads([offer(1), offer(2), offer(3)], ["offer-1", "offer-2"]);

    const selected = await selectTierForPurchase(r, INPUT);
    expect(selected?.offer?.offerId).toBe("offer-3");
    expect(r.confirmOffer.mock.calls.map(([id]) => id)).toEqual(["offer-1", "offer-2", "offer-3"]);
  });

  it("says the ticket type isn't on sale when every listed ticket was gone", async () => {
    const r = reads([offer(1)], ["offer-1"]);

    const selected = await selectTierForPurchase(r, INPUT);
    expect(selected).toMatchObject({ canBuy: false, blockedReason: "NO_LIVE_OFFER", offer: null });
  });

  it("stops checking after three dead tickets and shows the next as last recorded", async () => {
    const r = reads(
      [offer(1), offer(2), offer(3), offer(4), offer(5)],
      ["offer-1", "offer-2", "offer-3", "offer-4"],
    );

    const selected = await selectTierForPurchase(r, INPUT);
    expect(selected?.offer?.offerId).toBe("offer-4"); // buying re-checks it
    expect(r.confirmOffer).toHaveBeenCalledTimes(3);
  });

  it("shows the offer as last recorded when the ledger can't be checked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = reads([offer(1)]);
    r.confirmOffer.mockRejectedValueOnce(new Error("ledger unreachable"));

    expect((await selectTierForPurchase(r, INPUT))?.offer?.offerId).toBe("offer-1");
    expect(error).toHaveBeenCalled();
  });

  it("doesn't check a ticket it won't offer: one being bought, or after the event has started", async () => {
    const held = reads([offer(1, { purchasePending: true })]);
    expect(await selectTierForPurchase(held, INPUT)).toMatchObject({
      canBuy: false,
      blockedReason: "BEING_BOUGHT",
    });
    expect(held.confirmOffer).not.toHaveBeenCalled();

    const started = reads([offer(1)]);
    expect(await selectTierForPurchase(started, { ...INPUT, hasStarted: true })).toMatchObject({
      blockedReason: "EVENT_STARTED",
    });
    expect(started.confirmOffer).not.toHaveBeenCalled();
  });

  it("answers null for a ticket type the event doesn't have, and lets a failed read through", async () => {
    expect(await selectTierForPurchase(reads([offer(1)]), { ...INPUT, tierId: "other" })).toBeNull();
    expect(await selectTierForPurchase(reads([offer(1)]), { ...INPUT, tierId: undefined })).toBeNull();

    const broken = reads([offer(1)]);
    broken.availability.mockRejectedValueOnce(new Error("database down"));
    await expect(selectTierForPurchase(broken, INPUT)).rejects.toThrow("database down");
  });
});
