import { describe, expect, expectTypeOf, it } from "vitest";
import * as db from "@/generated/prisma/enums";
import { Drops, XrplAddress } from "./common";
import { OfferState } from "./entities";
import {
  EventDraftInput,
  EventQuery,
  SellerProfilePatch,
  TicketTierInput,
  type ResaleListing,
  type TicketTierView,
} from "./events";

/*
 * This slice must not redefine primitives or enums that the database already
 * owns. These tests pin that: a value rejected by the shared primitive must be
 * rejected here too, and the offer states the UI can render must be exactly the
 * states the database can store.
 */

describe("primitives are reused, not redefined", () => {
  it("applies the shared drops rule to tier prices", () => {
    expect(TicketTierInput.safeParse({ name: "GA", priceDrops: "2500000", totalSupply: 50 }).success).toBe(true);

    for (const bad of ["2.5", "-1", "025", "", "1e6", "100000000000000001"]) {
      expect(
        TicketTierInput.safeParse({ name: "GA", priceDrops: bad, totalSupply: 50 }).success,
        `priceDrops ${JSON.stringify(bad)} must be rejected`,
      ).toBe(false);
    }
  });

  it("rejects a drops value above total XRP supply exactly as common.ts does", () => {
    const overSupply = "100000000000000001";
    expect(Drops.safeParse(overSupply).success).toBe(false);
    expect(EventQuery.safeParse({ maxPriceDrops: overSupply }).success).toBe(false);
  });

  it("uses the shared address rule, so ambiguous base58 characters fail", () => {
    // 0, O, I and l are outside the Ripple base58 alphabet.
    const bad = "r0OIl000000000000000000000";
    expect(XrplAddress.safeParse(bad).success).toBe(false);
  });
});

describe("offer state matches the database", () => {
  it("renders exactly the states the database can store", () => {
    expect([...OfferState.options].sort()).toEqual(Object.values(db.OfferState).sort());
  });

  it("includes the terminal states a listing can reach", () => {
    // These were missing while this slice kept its own copy of the enum.
    for (const state of ["PENDING_SIGNATURE", "EXPIRED", "FAILED", "STALE"]) {
      expect(OfferState.options).toContain(state);
    }
  });

  it("types a resale listing's state as the database enum", () => {
    expectTypeOf<ResaleListing["state"]>().toEqualTypeOf<db.OfferState>();
  });
});

describe("EventDraftInput", () => {
  const valid = {
    title: "Night Market Live",
    startsAt: "2026-12-01T20:00:00.000Z",
    venue: "Vicar Street",
    city: "Dublin",
  };

  it("accepts a minimal draft and defaults the optional fields", () => {
    const parsed = EventDraftInput.parse(valid);
    expect(parsed.description).toBe("");
    expect(parsed.endsAt).toBeNull();
  });

  it("requires an offset-bearing UTC timestamp", () => {
    expect(EventDraftInput.safeParse({ ...valid, startsAt: "2026-12-01 20:00" }).success).toBe(false);
    expect(EventDraftInput.safeParse({ ...valid, startsAt: "2026-12-01T20:00:00" }).success).toBe(false);
  });

  it("trims and rejects a blank venue or a too-short title", () => {
    expect(EventDraftInput.parse({ ...valid, venue: "  Vicar Street  " }).venue).toBe("Vicar Street");
    expect(EventDraftInput.safeParse({ ...valid, venue: "   " }).success).toBe(false);
    expect(EventDraftInput.safeParse({ ...valid, title: "Hi" }).success).toBe(false);
  });

  it("allows artwork to be cleared with an empty string but not a non-URL", () => {
    expect(EventDraftInput.safeParse({ ...valid, artworkUrl: "" }).success).toBe(true);
    expect(EventDraftInput.safeParse({ ...valid, artworkUrl: "not-a-url" }).success).toBe(false);
  });
});

describe("TicketTierInput", () => {
  it("requires a whole, positive, bounded quantity", () => {
    const base = { name: "GA", priceDrops: "1000000" };
    expect(TicketTierInput.safeParse({ ...base, totalSupply: 1 }).success).toBe(true);
    expect(TicketTierInput.safeParse({ ...base, totalSupply: 0 }).success).toBe(false);
    expect(TicketTierInput.safeParse({ ...base, totalSupply: 2.5 }).success).toBe(false);
    expect(TicketTierInput.safeParse({ ...base, totalSupply: 10_001 }).success).toBe(false);
  });

  it("permits a free tier priced at zero drops", () => {
    expect(TicketTierInput.safeParse({ name: "Guest", priceDrops: "0", totalSupply: 5 }).success).toBe(true);
  });
});

describe("EventQuery", () => {
  it("defaults sort and limit so a bare request is valid", () => {
    const parsed = EventQuery.parse({});
    expect(parsed.sort).toBe("SOONEST");
    expect(parsed.limit).toBe(12);
  });

  it("coerces a string limit from the query string but enforces the cap", () => {
    expect(EventQuery.parse({ limit: "25" }).limit).toBe(25);
    expect(EventQuery.safeParse({ limit: "51" }).success).toBe(false);
    expect(EventQuery.safeParse({ limit: "0" }).success).toBe(false);
  });
});

describe("SellerProfilePatch", () => {
  it("caps the number of social links", () => {
    const link = { label: "Site", url: "https://example.com" };
    expect(SellerProfilePatch.safeParse({ socialLinks: Array(6).fill(link) }).success).toBe(true);
    expect(SellerProfilePatch.safeParse({ socialLinks: Array(7).fill(link) }).success).toBe(false);
  });

  it("rejects a social link that is not a URL", () => {
    expect(SellerProfilePatch.safeParse({ socialLinks: [{ label: "Site", url: "example.com" }] }).success).toBe(false);
  });
});

describe("read models expose derived inventory fields", () => {
  it("keeps remaining and locked on the tier view so the UI never recomputes them", () => {
    expectTypeOf<TicketTierView>().toHaveProperty("remaining").toEqualTypeOf<number>();
    expectTypeOf<TicketTierView>().toHaveProperty("locked").toEqualTypeOf<boolean>();
  });
});
