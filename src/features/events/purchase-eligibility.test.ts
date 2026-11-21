import { describe, expect, it } from "vitest";
import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { TierAvailability } from "@/contracts/inventory";
import {
  cheapestOfferForTier,
  tierPurchaseState,
  tierPurchaseStates,
} from "./purchase-eligibility";

function tier(overrides: Partial<TierAvailability> = {}): TierAvailability {
  return {
    tierId: "tier-1",
    name: "GA",
    priceDrops: "25000000",
    totalSupply: 100,
    sold: 0,
    remaining: 100,
    pending: 0,
    fromPriceDrops: "25000000",
    ...overrides,
  };
}

function offer(overrides: Partial<PrimaryOfferListing> = {}): PrimaryOfferListing {
  return {
    offerId: "off-1",
    offerIndex: "A".repeat(64),
    nftokenId: "B".repeat(64),
    sellerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    amountDrops: "25000000",
    tierId: "tier-1",
    tierName: "GA",
    ticketId: "tkt-1",
    serial: 1,
    expiresAt: null,
    purchasePending: false,
    ...overrides,
  };
}

const OPEN = { isPublished: true, hasStarted: false };

describe("cheapestOfferForTier", () => {
  it("returns null when nothing is listed for the tier", () => {
    expect(cheapestOfferForTier([], "tier-1")).toBeNull();
    expect(cheapestOfferForTier([offer({ tierId: "other" })], "tier-1")).toBeNull();
  });

  it("picks the cheapest, comparing numerically", () => {
    // "9000000" sorts after "10000000" as a string but is cheaper.
    const cheapest = cheapestOfferForTier(
      [offer({ offerId: "a", amountDrops: "10000000" }), offer({ offerId: "b", amountDrops: "9000000" })],
      "tier-1",
    );
    expect(cheapest?.offerId).toBe("b");
  });

  it("ignores offers for other tiers", () => {
    const cheapest = cheapestOfferForTier(
      [
        offer({ offerId: "cheap-other", tierId: "tier-2", amountDrops: "1" }),
        offer({ offerId: "mine", amountDrops: "25000000" }),
      ],
      "tier-1",
    );
    expect(cheapest?.offerId).toBe("mine");
  });

  it("passes over a ticket another buyer is in the middle of buying, even a cheaper one (XRPL-035)", () => {
    const cheapest = cheapestOfferForTier(
      [
        offer({ offerId: "held-cheap", amountDrops: "9000000", purchasePending: true }),
        offer({ offerId: "held", purchasePending: true }),
        offer({ offerId: "free-dear", amountDrops: "30000000" }),
        offer({ offerId: "free" }),
      ],
      "tier-1",
    );
    expect(cheapest?.offerId).toBe("free");
  });

  it("falls back to the cheapest held ticket when every one is being bought", () => {
    const cheapest = cheapestOfferForTier(
      [
        offer({ offerId: "held", purchasePending: true }),
        offer({ offerId: "held-cheap", amountDrops: "9000000", purchasePending: true }),
      ],
      "tier-1",
    );
    expect(cheapest?.offerId).toBe("held-cheap");
  });
});

describe("a tier is buyable only with a live offer", () => {
  it("is buyable when an offer exists", () => {
    const state = tierPurchaseState(tier(), [offer()], OPEN);
    expect(state.canBuy).toBe(true);
    expect(state.blockedReason).toBeNull();
    expect(state.offer?.offerId).toBe("off-1");
  });

  it("is not buyable on declared supply alone", () => {
    // A seller can define a tier and never mint or list it; remaining stock is
    // not an offer.
    const state = tierPurchaseState(tier({ remaining: 100 }), [], OPEN);
    expect(state.canBuy).toBe(false);
    expect(state.blockedReason).toBe("NO_LIVE_OFFER");
    expect(state.blockedMessage).toBe("Not on sale right now");
  });

  it("is not buyable when an offer exists only for another tier", () => {
    const state = tierPurchaseState(tier(), [offer({ tierId: "tier-2" })], OPEN);
    expect(state.canBuy).toBe(false);
    expect(state.blockedReason).toBe("NO_LIVE_OFFER");
  });
});

describe("blocked reasons, most specific first", () => {
  it("reports sold out when nothing remains, even with a stale offer listed", () => {
    const state = tierPurchaseState(tier({ sold: 100, remaining: 0 }), [offer()], OPEN);
    expect(state.canBuy).toBe(false);
    expect(state.blockedReason).toBe("SOLD_OUT");
  });

  it("reports a started event ahead of inventory", () => {
    const state = tierPurchaseState(tier(), [offer()], {
      isPublished: true,
      hasStarted: true,
    });
    expect(state.canBuy).toBe(false);
    expect(state.blockedReason).toBe("EVENT_STARTED");
  });

  it("reports an unpublished event ahead of everything else", () => {
    const state = tierPurchaseState(tier({ remaining: 0 }), [], {
      isPublished: false,
      hasStarted: true,
    });
    expect(state.blockedReason).toBe("NOT_PUBLISHED");
  });

  it("always pairs a reason with buyer-facing wording", () => {
    for (const context of [
      { isPublished: false, hasStarted: false },
      { isPublished: true, hasStarted: true },
    ]) {
      const state = tierPurchaseState(tier(), [offer()], context);
      expect(state.blockedReason).not.toBeNull();
      expect(state.blockedMessage).toBeTruthy();
    }
  });
});

describe("pending purchases", () => {
  it("does not block buying, because pending units stay in remaining", () => {
    // A purchase in flight might still fail, so its unit is not yet sold.
    const state = tierPurchaseState(tier({ remaining: 5, pending: 3 }), [offer()], OPEN);
    expect(state.canBuy).toBe(true);
    expect(state.pending).toBe(3);
  });

  it("is surfaced so the buyer knows stock is contested", () => {
    expect(tierPurchaseState(tier({ pending: 2 }), [offer()], OPEN).pending).toBe(2);
  });

  it("offers a ticket nobody else is buying while one is left (XRPL-035)", () => {
    const state = tierPurchaseState(
      tier({ remaining: 2, pending: 1 }),
      [offer({ offerId: "held", serial: 1, purchasePending: true }), offer({ offerId: "free", serial: 2 })],
      OPEN,
    );
    expect(state.canBuy).toBe(true);
    expect(state.offer?.offerId).toBe("free");
  });

  it("blocks buying while another buyer holds every ticket on sale, and says so (XRPL-035)", () => {
    const state = tierPurchaseState(
      tier({ remaining: 1, pending: 1 }),
      [offer({ purchasePending: true })],
      OPEN,
    );
    expect(state.canBuy).toBe(false);
    expect(state.blockedReason).toBe("BEING_BOUGHT");
    expect(state.blockedMessage).toBe("Being bought right now");
    // The held offer is still reported, so the page can show its price.
    expect(state.offer?.offerId).toBe("off-1");
  });

  it("reports sold out ahead of a held ticket", () => {
    const state = tierPurchaseState(tier({ sold: 100, remaining: 0 }), [offer({ purchasePending: true })], OPEN);
    expect(state.blockedReason).toBe("SOLD_OUT");
  });
});

describe("tierPurchaseStates", () => {
  it("evaluates each tier independently", () => {
    const states = tierPurchaseStates(
      [
        tier({ tierId: "t1", name: "GA" }),
        tier({ tierId: "t2", name: "VIP", remaining: 0, sold: 10, totalSupply: 10 }),
        tier({ tierId: "t3", name: "Standing" }),
      ],
      [offer({ tierId: "t1" })],
      OPEN,
    );

    expect(states.map((s) => [s.name, s.canBuy, s.blockedReason])).toEqual([
      ["GA", true, null],
      ["VIP", false, "SOLD_OUT"],
      ["Standing", false, "NO_LIVE_OFFER"],
    ]);
  });

  it("keeps the face value available even when nothing is on sale", () => {
    const [state] = tierPurchaseStates([tier({ priceDrops: "25000000" })], [], OPEN);
    expect(state!.priceDrops).toBe("25000000");
    expect(state!.offer).toBeNull();
  });
});
