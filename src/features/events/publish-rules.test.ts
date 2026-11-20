import { describe, expect, it } from "vitest";
import type { EventView, TicketTierView } from "@/contracts";
import {
  NFT_RELEVANT_FIELDS,
  canPublish,
  canUnpublish,
  describeLockedFields,
  hasMintedTickets,
  lockedFieldsInPatch,
  mintedTicketCount,
  publishBlockers,
} from "./publish-rules";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const FUTURE = "2026-12-01T20:00:00.000Z";
const PAST = "2026-11-01T20:00:00.000Z";

function tier(overrides: Partial<TicketTierView> = {}): TicketTierView {
  return {
    id: "tier-1",
    eventId: "evt-1",
    name: "GA",
    description: "",
    priceDrops: "25000000",
    totalSupply: 100,
    mintedQuantity: 0,
    soldQuantity: 0,
    remaining: 100,
    locked: false,
    ...overrides,
  };
}

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "evt-1",
    seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    title: "Night Market Live",
    description: "",
    startsAt: FUTURE,
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "DRAFT",
    artworkUrl: null,
    tiers: [tier()],
    publishedAt: null,
    ...overrides,
  };
}

describe("minted ticket detection", () => {
  it("is false with no tiers and with unminted tiers", () => {
    expect(hasMintedTickets(event({ tiers: [] }))).toBe(false);
    expect(hasMintedTickets(event())).toBe(false);
  });

  it("is true as soon as one tier has a minted ticket", () => {
    const e = event({ tiers: [tier(), tier({ id: "t2", mintedQuantity: 1 })] });
    expect(hasMintedTickets(e)).toBe(true);
    expect(mintedTicketCount(e)).toBe(1);
  });

  it("totals minted tickets across tiers", () => {
    expect(
      mintedTicketCount(
        event({ tiers: [tier({ mintedQuantity: 12 }), tier({ id: "t2", mintedQuantity: 30 })] }),
      ),
    ).toBe(42);
  });
});

describe("publishBlockers", () => {
  it("allows a complete future-dated draft with supply", () => {
    expect(publishBlockers(event(), NOW)).toEqual([]);
    expect(canPublish(event(), NOW)).toBe(true);
  });

  it("blocks an event with no tiers", () => {
    const blockers = publishBlockers(event({ tiers: [] }), NOW);
    expect(blockers.map((b) => b.code)).toEqual(["NO_TIERS"]);
    expect(canPublish(event({ tiers: [] }), NOW)).toBe(false);
  });

  it("blocks an event whose start time has passed", () => {
    const blockers = publishBlockers(event({ startsAt: PAST }), NOW);
    expect(blockers.map((b) => b.code)).toEqual(["EVENT_IN_PAST"]);
  });

  it("treats a start time exactly now as already passed", () => {
    expect(publishBlockers(event({ startsAt: NOW.toISOString() }), NOW).map((b) => b.code)).toEqual(
      ["EVENT_IN_PAST"],
    );
  });

  it("reports every blocker at once rather than one per attempt", () => {
    const blockers = publishBlockers(event({ tiers: [], startsAt: PAST }), NOW);
    expect(blockers.map((b) => b.code)).toEqual(["NO_TIERS", "EVENT_IN_PAST"]);
  });

  it("never reports an already-publishable draft as publishable twice", () => {
    expect(canPublish(event({ status: "PUBLISHED" }), NOW)).toBe(false);
  });

  it("carries a message a seller can act on", () => {
    for (const blocker of publishBlockers(event({ tiers: [], startsAt: PAST }), NOW)) {
      expect(blocker.message.length).toBeGreaterThan(10);
    }
  });
});

describe("canUnpublish", () => {
  it("allows returning a published event with no minted tickets to draft", () => {
    expect(canUnpublish(event({ status: "PUBLISHED" }))).toBe(true);
  });

  it("refuses once tickets exist on the ledger", () => {
    // Buyers may already hold them; hiding the event would strip the page the
    // ticket refers to.
    expect(
      canUnpublish(event({ status: "PUBLISHED", tiers: [tier({ mintedQuantity: 1 })] })),
    ).toBe(false);
  });

  it("refuses for an event that is already a draft", () => {
    expect(canUnpublish(event({ status: "DRAFT" }))).toBe(false);
  });
});

describe("lockedFieldsInPatch", () => {
  const minted = event({ tiers: [tier({ mintedQuantity: 5 })] });

  it("locks nothing before anything is minted", () => {
    expect(lockedFieldsInPatch(event(), { title: "Something else" })).toEqual([]);
  });

  it("locks every NFT-relevant field once minting has started", () => {
    const locked = lockedFieldsInPatch(minted, {
      title: "Renamed",
      startsAt: "2027-01-01T20:00:00.000Z",
      endsAt: "2027-01-01T23:00:00.000Z",
      venue: "Elsewhere",
      city: "Cork",
      artworkUrl: "https://example.com/a.png",
    });
    expect(locked.sort()).toEqual([...NFT_RELEVANT_FIELDS].sort());
  });

  it("leaves the description editable after minting", () => {
    expect(lockedFieldsInPatch(minted, { description: "New blurb" })).toEqual([]);
  });

  it("does not treat an unchanged value as a change", () => {
    // Re-saving an untouched form must not be rejected.
    expect(
      lockedFieldsInPatch(minted, {
        title: minted.title,
        venue: minted.venue,
        city: minted.city,
      }),
    ).toEqual([]);
  });

  it("compares timestamps as instants, not strings", () => {
    const e = event({ startsAt: "2026-12-01T20:00:00.000Z", tiers: [tier({ mintedQuantity: 1 })] });
    // Same instant written with an offset instead of Z.
    expect(lockedFieldsInPatch(e, { startsAt: "2026-12-01T21:00:00.000+01:00" })).toEqual([]);
    expect(lockedFieldsInPatch(e, { startsAt: "2026-12-01T21:00:00.000Z" })).toEqual(["startsAt"]);
  });

  it("treats empty-string and null artwork as the same absence", () => {
    const noArt = event({ artworkUrl: null, tiers: [tier({ mintedQuantity: 1 })] });
    expect(lockedFieldsInPatch(noArt, { artworkUrl: "" })).toEqual([]);

    const withArt = event({
      artworkUrl: "https://example.com/a.png",
      tiers: [tier({ mintedQuantity: 1 })],
    });
    expect(lockedFieldsInPatch(withArt, { artworkUrl: "" })).toEqual(["artworkUrl"]);
  });

  it("ignores fields absent from the patch", () => {
    expect(lockedFieldsInPatch(minted, {})).toEqual([]);
  });
});

describe("describeLockedFields", () => {
  it("reads naturally for one, two and many fields", () => {
    expect(describeLockedFields(["venue"])).toBe("venue");
    expect(describeLockedFields(["venue", "city"])).toBe("venue and city");
    expect(describeLockedFields(["title", "venue", "city"])).toBe("event name, venue and city");
  });
});
