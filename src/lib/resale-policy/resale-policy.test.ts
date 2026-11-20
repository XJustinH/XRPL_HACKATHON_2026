// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import type { EventAvailability, ResaleListing } from "@/contracts/events";
import { FakeClock } from "@/features/checkin/testing/fakes";
import { type PolicyEvent, ResalePolicy } from "./resale-policy";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const listing = (over: Partial<ResaleListing> & { eventId?: string } = {}): ResaleListing => {
  const { eventId = EVENT, ...rest } = over;
  return {
    offerId: "o1",
    offerIndex: "A".repeat(64),
    nftokenId: "B".repeat(64),
    sellerAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    amountDrops: "25000000",
    kind: "RESALE",
    state: "ACTIVE",
    createTxHash: "C".repeat(64),
    createdAt: "2026-11-30T10:00:00.000Z",
    ticket: { id: "t1", serial: 1, tierName: "GA", faceValueDrops: "20000000" },
    event: { id: eventId, title: "Gig", startsAt: "2026-12-05T20:00:00.000Z", venue: "V", city: "Dublin" },
    ...rest,
  } as ResaleListing;
};

describe("XRPL-037 in-app resale policy", () => {
  let clock: FakeClock;
  let event: PolicyEvent | null;
  let availability: EventAvailability;
  let offers: ResaleListing[];
  let inventoryDown: boolean;
  let policy: ResalePolicy;

  beforeEach(() => {
    clock = new FakeClock(new Date("2026-12-01T12:00:00Z").getTime());
    event = { id: EVENT, status: "PUBLISHED", startsAt: "2026-12-05T20:00:00.000Z", endsAt: null };
    availability = {
      eventId: EVENT,
      totalSupply: 100,
      sold: 100,
      remaining: 0,
      isSoldOut: true,
      fromPriceDrops: null,
      calculatedAt: "2026-12-01T11:59:00.000Z",
    };
    offers = [listing()];
    inventoryDown = false;
    policy = new ResalePolicy({
      clock,
      events: { getEvent: async (id) => (event && event.id === id ? event : null) },
      inventory: {
        getAvailability: async () => {
          if (inventoryDown) throw new Error("db down");
          return availability;
        },
      },
      offers: { listResaleOffers: async (id) => offers.filter((o) => o.event.id === id || id === EVENT) },
    });
  });

  it("allows resale once primary is sold out and includes the limitation notice", async () => {
    const e = await policy.getEligibility(EVENT);
    expect(e).toMatchObject({ eventId: EVENT, isPublicResaleAllowed: true, reasonCode: "PRIMARY_SOLD_OUT" });
    expect(e.message).toContain(RESALE_LIMITATION_NOTICE);
    expect(e.evaluatedAt).toBe("2026-12-01T12:00:00.000Z");
  });

  it("hides resale while primary tickets remain, and says why", async () => {
    availability = { ...availability, sold: 97, remaining: 3, isSoldOut: false };
    const e = await policy.getEligibility(EVENT);
    expect(e).toMatchObject({ isPublicResaleAllowed: false, reasonCode: "PRIMARY_STILL_ON_SALE" });
    expect(e.message).toContain("outside this app");
    expect((await policy.listPublicOffers(EVENT)).offers).toEqual([]);
  });

  it("treats inconsistent availability as not sold out", async () => {
    availability = { ...availability, isSoldOut: true, remaining: 1 };
    expect(await policy.isPublicResaleAllowed(EVENT)).toBe(false);
    availability = { ...availability, totalSupply: 0, remaining: 0, isSoldOut: true };
    expect(await policy.isPublicResaleAllowed(EVENT)).toBe(false);
  });

  it("direct single-offer lookup cannot reveal a hidden listing", async () => {
    availability = { ...availability, remaining: 1, isSoldOut: false };
    expect(await policy.getPublicOffer(EVENT, "o1")).toBeNull();
    availability = { ...availability, remaining: 0, isSoldOut: true };
    expect(await policy.getPublicOffer(EVENT, "o1")).toMatchObject({ offerId: "o1" });
  });

  it("is closed for draft, unknown and finished events", async () => {
    event = { ...event!, status: "DRAFT" };
    expect(await policy.getEligibility(EVENT)).toMatchObject({ reasonCode: "EVENT_NOT_PUBLISHED", isPublicResaleAllowed: false });
    expect(await policy.getEligibility(OTHER)).toMatchObject({ reasonCode: "EVENT_NOT_PUBLISHED" });
    event = { ...event!, status: "PUBLISHED", startsAt: "2026-11-30T20:00:00.000Z", endsAt: null };
    expect(await policy.getEligibility(EVENT)).toMatchObject({ reasonCode: "EVENT_FINISHED", isPublicResaleAllowed: false });
  });

  it("uses endsAt when present: an event in progress is not finished", async () => {
    event = { ...event!, startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T23:00:00.000Z" };
    expect(await policy.getEligibility(EVENT)).toMatchObject({ reasonCode: "PRIMARY_SOLD_OUT" });
  });

  it("lists only live public resale offers for this event", async () => {
    offers = [
      listing(),
      listing({ offerId: "primary", kind: "PRIMARY" }),
      listing({ offerId: "private", kind: "PRIVATE" }),
      listing({ offerId: "gift", kind: "GIFT" }),
      listing({ offerId: "cancelled", state: "CANCELLED" }),
      listing({ offerId: "stale", state: "STALE" }),
      listing({ offerId: "other-event", eventId: OTHER }),
    ];
    expect((await policy.listPublicOffers(EVENT)).offers.map((o) => o.offerId)).toEqual(["o1"]);
  });

  it("propagates inventory failures instead of listing anything", async () => {
    inventoryDown = true;
    await expect(policy.listPublicOffers(EVENT)).rejects.toThrow();
    await expect(policy.getPublicOffer(EVENT, "o1")).rejects.toThrow();
  });
});
