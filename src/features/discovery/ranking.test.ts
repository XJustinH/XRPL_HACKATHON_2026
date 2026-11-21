import { describe, expect, it } from "vitest";
import type { EventView } from "@/contracts";
import { hasRankingSignals, rankEvents, scoreEvent } from "./ranking";

function event(overrides: Partial<EventView> = {}): EventView {
  return {
    id: "evt-1",
    seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    title: "An evening out",
    description: "",
    startsAt: "2099-12-01T20:00:00.000Z",
    endsAt: null,
    venue: "Vicar Street",
    city: "Dublin",
    status: "PUBLISHED",
    artworkUrl: null,
    tiers: [],
    publishedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

const NO_SIGNALS = { interests: [], city: null } as const;

describe("ranking never hides anything", () => {
  it("returns every event it was given", () => {
    const events = [event({ id: "a" }), event({ id: "b", city: "Cork" }), event({ id: "c" })];
    const ranked = rankEvents(events, { interests: ["MUSIC"], city: "Dublin" });
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.event.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("leaves order untouched when there are no preferences", () => {
    // A customer with nothing set must see exactly what everyone else sees.
    const events = [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })];
    expect(rankEvents(events, NO_SIGNALS).map((r) => r.event.id)).toEqual(["a", "b", "c"]);
  });

  it("scores everything zero with no preferences", () => {
    for (const scored of rankEvents([event(), event({ city: "Cork" })], NO_SIGNALS)) {
      expect(scored.score).toBe(0);
      expect(scored.reasons).toEqual([]);
    }
  });
});

describe("city signal", () => {
  it("ranks a matching city above a non-matching one", () => {
    const events = [event({ id: "cork", city: "Cork" }), event({ id: "dub", city: "Dublin" })];
    const ranked = rankEvents(events, { interests: [], city: "Dublin" });
    expect(ranked[0]!.event.id).toBe("dub");
    expect(ranked[0]!.reasons).toContain("In Dublin");
  });

  it("matches a city ignoring case and padding", () => {
    expect(scoreEvent(event({ city: "Dublin" }), { interests: [], city: "  dublin " }).score)
      .toBeGreaterThan(0);
  });

  it("does not partially match a different place", () => {
    // "Dublin 8" is not Dublin for ranking purposes.
    expect(scoreEvent(event({ city: "Dublin 8" }), { interests: [], city: "Dublin" }).score)
      .toBe(0);
  });

  it("uses no coordinate or device signal, only the typed city", () => {
    const scored = scoreEvent(event(), { interests: [], city: "Dublin" });
    // The only location input is the string; there is nothing else to pass.
    expect(scored.reasons).toEqual(["In Dublin"]);
  });
});

describe("interest signal", () => {
  it("matches an interest against the event text", () => {
    const scored = scoreEvent(
      event({ title: "Stand-up comedy night" }),
      { interests: ["COMEDY"], city: null },
    );
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons[0]).toMatch(/looks like comedy/i);
  });

  it("matches on the description as well as the title", () => {
    const scored = scoreEvent(
      event({ title: "Saturday session", description: "A techno club night." }),
      { interests: ["CLUB"], city: null },
    );
    expect(scored.score).toBeGreaterThan(0);
  });

  it("says 'looks like', because this is a text guess not a declared category", () => {
    const scored = scoreEvent(event({ title: "Live music" }), {
      interests: ["MUSIC"],
      city: null,
    });
    expect(scored.reasons.join(" ")).toMatch(/looks like/i);
  });

  it("does not match an unrelated interest", () => {
    expect(
      scoreEvent(event({ title: "Stand-up comedy night" }), {
        interests: ["SPORT"],
        city: null,
      }).score,
    ).toBe(0);
  });

  it("caps how much one event can gain from interests", () => {
    // A title stuffed with keywords must not outrank everything.
    const stuffed = event({
      title: "music club comedy theatre film art sport food community talk family",
    });
    const scored = scoreEvent(stuffed, {
      interests: ["MUSIC", "CLUB", "COMEDY", "THEATRE", "FILM", "ARTS"],
      city: null,
    });
    expect(scored.reasons).toHaveLength(3);
  });

  it("never matches the OTHER category, which has no keywords", () => {
    expect(
      scoreEvent(event({ title: "Something else entirely" }), {
        interests: ["OTHER"],
        city: null,
      }).score,
    ).toBe(0);
  });
});

describe("combined signals", () => {
  it("weights the city above a single interest", () => {
    const rightCity = event({ id: "city", city: "Dublin", title: "An evening out" });
    const rightInterest = event({ id: "interest", city: "Cork", title: "Comedy night" });
    const ranked = rankEvents([rightInterest, rightCity], {
      interests: ["COMEDY"],
      city: "Dublin",
    });
    // Being able to get there beats a topic guess.
    expect(ranked[0]!.event.id).toBe("city");
  });

  it("ranks an event matching both above one matching either", () => {
    const both = event({ id: "both", city: "Dublin", title: "Comedy night" });
    const cityOnly = event({ id: "city", city: "Dublin" });
    const ranked = rankEvents([cityOnly, both], { interests: ["COMEDY"], city: "Dublin" });
    expect(ranked[0]!.event.id).toBe("both");
    expect(ranked[0]!.reasons).toHaveLength(2);
  });

  it("is deterministic: the same inputs give the same order", () => {
    const events = [
      event({ id: "a", city: "Dublin" }),
      event({ id: "b", title: "Comedy" }),
      event({ id: "c", city: "Cork" }),
    ];
    const signals = { interests: ["COMEDY"] as const, city: "Dublin" };
    const first = rankEvents(events, signals).map((r) => r.event.id);
    expect(rankEvents(events, signals).map((r) => r.event.id)).toEqual(first);
  });

  it("keeps the incoming order for equally scored events", () => {
    // The listing arrives soonest-first, so date stays the tiebreak.
    const events = [event({ id: "soon" }), event({ id: "later" })];
    expect(rankEvents(events, { interests: [], city: "Nowhere" }).map((r) => r.event.id)).toEqual(
      ["soon", "later"],
    );
  });
});

describe("followed organisers (XRPL-090)", () => {
  const followed = { interests: [], city: null, followedSellerIds: ["usr-1"] } as const;

  it("promotes an event from a followed organiser and names them", () => {
    const scored = scoreEvent(event(), followed);
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons).toContain("You follow Night Market");
  });

  it("does not promote an organiser the customer does not follow", () => {
    expect(
      scoreEvent(event(), { interests: [], city: null, followedSellerIds: ["someone-else"] })
        .score,
    ).toBe(0);
  });

  it("outranks a city match, because following is a deliberate choice", () => {
    const followedEvent = event({
      id: "followed",
      city: "Cork",
      seller: { id: "usr-1", displayName: "Night Market", city: null, isVerified: false },
    });
    const sameCity = event({
      id: "city",
      city: "Dublin",
      seller: { id: "other", displayName: "Someone", city: null, isVerified: false },
    });

    const ranked = rankEvents([sameCity, followedEvent], {
      interests: [],
      city: "Dublin",
      followedSellerIds: ["usr-1"],
    });
    expect(ranked[0]!.event.id).toBe("followed");
  });

  it("stacks with the other signals", () => {
    const scored = scoreEvent(
      event({ city: "Dublin", title: "Comedy night" }),
      { interests: ["COMEDY"], city: "Dublin", followedSellerIds: ["usr-1"] },
    );
    expect(scored.reasons).toHaveLength(3);
  });

  it("is absent when no follows are supplied at all", () => {
    expect(scoreEvent(event(), { interests: [], city: null }).score).toBe(0);
  });
});

describe("hasRankingSignals", () => {
  it("is false with nothing set", () => {
    expect(hasRankingSignals(NO_SIGNALS)).toBe(false);
    expect(hasRankingSignals({ interests: [], city: "   " })).toBe(false);
    expect(hasRankingSignals({ interests: [], city: null, followedSellerIds: [] })).toBe(false);
  });

  it("is true with an interest, a city, or a follow", () => {
    expect(hasRankingSignals({ interests: ["MUSIC"], city: null })).toBe(true);
    expect(hasRankingSignals({ interests: [], city: "Dublin" })).toBe(true);
    expect(
      hasRankingSignals({ interests: [], city: null, followedSellerIds: ["usr-1"] }),
    ).toBe(true);
  });
});
