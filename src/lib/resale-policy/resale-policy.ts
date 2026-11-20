/**
 * In-app resale publication policy (XRPL-037). Implements `ResalePolicyPort`.
 *
 * Rule: resale offers are listed publicly in this app only when the event is published, has
 * not finished, and every primary ticket has sold. This is an APP rule. Ticket NFTs are
 * transferable, so it cannot stop sales or transfers made directly on XRPL; the UI must show
 * RESALE_LIMITATION_NOTICE.
 *
 * Optional price guardrails (XRPL-095, off by default) also hide listings priced too far above face value.
 *
 * Every public resale read (list, single offer, buy intent) must go through `listPublicOffers`
 * or `getPublicOffer`, so a direct API call cannot reach a hidden listing. If inventory or
 * offers cannot be read, the error propagates (route returns 503): nothing is listed.
 */
import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import type { EventAvailability, ResaleEligibility, ResaleListing } from "@/contracts/events";
import type { EventStatus } from "@/contracts/entities";
import type { Clock } from "@/features/checkin/ports";
import { systemClock } from "@/features/checkin/ports";
import type { InventoryPort, OfferPort, ResalePolicyPort } from "@/features/integration/ports";

/** The event fields the rule needs; `EventView` satisfies this. */
export type PolicyEvent = { id: string; status: EventStatus; startsAt: string; endsAt?: string | null };

/**
 * Optional, platform-only price guardrails (XRPL-095). Off unless configured. They only decide what
 * this app lists; they cannot stop a sale on another marketplace or a wallet-to-wallet transfer.
 * See docs/resale-guardrails.md.
 */
export type ResaleGuardrails = {
  /** Hide public resale listings priced above face value + this percentage (integer, 0..1000). */
  maxMarkupPercent?: number;
};

export type ResalePolicyDeps = {
  events: { getEvent(eventId: string): Promise<PolicyEvent | null> };
  inventory: Pick<InventoryPort, "getAvailability">;
  offers: Pick<OfferPort, "listResaleOffers">;
  clock?: Clock;
  guardrails?: ResaleGuardrails;
};

export type ResalePriceCheck =
  | { allowed: true; maxDrops: string | null }
  | { allowed: false; maxDrops: string; message: string };

const MESSAGES: Record<ResaleEligibility["reasonCode"], string> = {
  PRIMARY_SOLD_OUT: `Primary tickets have sold out, so resale tickets are listed here. ${RESALE_LIMITATION_NOTICE}`,
  PRIMARY_STILL_ON_SALE: `Resale opens in this app once all primary tickets have sold. ${RESALE_LIMITATION_NOTICE}`,
  EVENT_NOT_PUBLISHED: "This event is not on sale.",
  EVENT_FINISHED: "This event has finished, so resale is closed.",
};

export class ResalePolicy implements ResalePolicyPort {
  private readonly clock: Clock;

  private readonly maxMarkupPercent: number | null;

  constructor(private readonly deps: ResalePolicyDeps) {
    this.clock = deps.clock ?? systemClock;
    const pct = deps.guardrails?.maxMarkupPercent;
    if (pct !== undefined && (!Number.isInteger(pct) || pct < 0 || pct > 1000)) {
      throw new Error("maxMarkupPercent must be an integer between 0 and 1000");
    }
    this.maxMarkupPercent = pct ?? null;
  }

  /** Text for the UI when a price cap is on, or null when there is none. */
  priceCapNotice(): string | null {
    if (this.maxMarkupPercent === null) return null;
    const cap = this.maxMarkupPercent === 0 ? "face value" : `${this.maxMarkupPercent}% above face value`;
    return `In this app, resale tickets can't be listed above ${cap}. This doesn't apply to sales made outside the app.`;
  }

  /**
   * Check a resale price before the seller creates the offer on XRPL, so they are not left with a
   * live offer the app will hide. Agent B's resale-offer route can call this (XRPL-036).
   */
  checkResalePrice(faceValueDrops: string, amountDrops: string): ResalePriceCheck {
    if (this.maxMarkupPercent === null) return { allowed: true, maxDrops: null };
    const maxDrops = maxResalePriceDrops(faceValueDrops, this.maxMarkupPercent);
    if (BigInt(amountDrops) <= BigInt(maxDrops)) return { allowed: true, maxDrops };
    return { allowed: false, maxDrops, message: this.priceCapNotice()! };
  }

  /** GET /api/events/:id/resale-eligibility. Unknown events read as not published. */
  async getEligibility(eventId: string): Promise<ResaleEligibility> {
    const now = this.clock.now();
    const result = (reasonCode: ResaleEligibility["reasonCode"]): ResaleEligibility => ({
      eventId,
      isPublicResaleAllowed: reasonCode === "PRIMARY_SOLD_OUT",
      reasonCode,
      message: MESSAGES[reasonCode],
      evaluatedAt: now.toISOString(),
    });

    const event = await this.deps.events.getEvent(eventId);
    if (!event || event.status !== "PUBLISHED") return result("EVENT_NOT_PUBLISHED");
    if (new Date(event.endsAt ?? event.startsAt).getTime() <= now.getTime()) return result("EVENT_FINISHED");

    const availability = await this.deps.inventory.getAvailability(eventId);
    return result(isPrimarySoldOut(availability) ? "PRIMARY_SOLD_OUT" : "PRIMARY_STILL_ON_SALE");
  }

  /** D → B/C contract (handoff §7). */
  async isPublicResaleAllowed(eventId: string): Promise<boolean> {
    return (await this.getEligibility(eventId)).isPublicResaleAllowed;
  }

  /** GET /api/events/:id/resale-offers: only when eligible, and only live public resale offers. */
  async listPublicOffers(eventId: string): Promise<{ eligibility: ResaleEligibility; offers: ResaleListing[] }> {
    const eligibility = await this.getEligibility(eventId);
    if (!eligibility.isPublicResaleAllowed) return { eligibility, offers: [] };
    const offers = (await this.deps.offers.listResaleOffers(eventId)).filter(
      (o) => isPublicResaleListing(o, eventId) && this.withinPriceCap(o),
    );
    return { eligibility, offers };
  }

  /**
   * Single-offer read and buy guard. Null for anything the public must not see.
   * Agent B's resale accept-intent route must call this before preparing a purchase.
   */
  async getPublicOffer(eventId: string, offerId: string): Promise<ResaleListing | null> {
    const { offers } = await this.listPublicOffers(eventId);
    return offers.find((o) => o.offerId === offerId) ?? null;
  }

  private withinPriceCap(o: ResaleListing): boolean {
    return this.checkResalePrice(o.ticket.faceValueDrops, o.amountDrops).allowed;
  }
}

/** Highest allowed resale price: face value × (100 + percent) / 100, rounded down, in integer drops. */
export function maxResalePriceDrops(faceValueDrops: string, maxMarkupPercent: number): string {
  return ((BigInt(faceValueDrops) * BigInt(100 + maxMarkupPercent)) / BigInt(100)).toString();
}

/** Sold out only when there was supply and none is left; both fields must agree. */
export function isPrimarySoldOut(a: EventAvailability): boolean {
  return a.totalSupply > 0 && a.remaining === 0 && a.isSoldOut;
}

/** Defence in depth on top of OfferPort: public resale only, live, for this event. */
function isPublicResaleListing(o: ResaleListing, eventId: string): boolean {
  return o.kind === "RESALE" && o.state === "ACTIVE" && o.event.id === eventId;
}
