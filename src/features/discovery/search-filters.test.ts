import { describe, expect, it } from "vitest";
import { parseSearchParams, searchQueryString } from "./search-filters";

describe("parseSearchParams", () => {
  it("reports no filters for an empty query", () => {
    const result = parseSearchParams({});
    expect(result.hasFilters).toBe(false);
    expect(result.filters.q).toBeUndefined();
    expect(result.filters.city).toBeUndefined();
  });

  it("reads each filter", () => {
    const { filters, hasFilters } = parseSearchParams({
      q: "market",
      city: "Dublin",
      venue: "Vicar",
      sellerId: "3f1a8b0c-0000-4000-8000-000000000000",
    });
    expect(hasFilters).toBe(true);
    expect(filters).toMatchObject({
      q: "market",
      city: "Dublin",
      venue: "Vicar",
      sellerId: "3f1a8b0c-0000-4000-8000-000000000000",
    });
  });

  it("treats a blank field as no filter rather than matching empty", () => {
    const { filters, hasFilters } = parseSearchParams({ q: "   ", city: "" });
    expect(hasFilters).toBe(false);
    expect(filters.q).toBeUndefined();
    expect(filters.city).toBeUndefined();
  });

  it("expands a date into a full UTC day", () => {
    const { filters } = parseSearchParams({ from: "2026-12-01", to: "2026-12-31" });
    expect(filters.from).toBe("2026-12-01T00:00:00.000Z");
    // Inclusive of the whole end day, so an event that evening is included.
    expect(filters.to).toBe("2026-12-31T23:59:59.999Z");
  });

  it("ignores a malformed date instead of failing", () => {
    const { filters, hasFilters } = parseSearchParams({ from: "01/12/2026", to: "nonsense" });
    expect(filters.from).toBeUndefined();
    expect(filters.to).toBeUndefined();
    // The raw value is still reported so the form can show what was typed.
    expect(hasFilters).toBe(true);
  });

  it("drops an invalid organiser id rather than erroring", () => {
    const { filters } = parseSearchParams({ sellerId: "not-a-uuid" });
    expect(filters.sellerId).toBeUndefined();
  });

  it("takes the first value when a parameter is repeated", () => {
    expect(parseSearchParams({ city: ["Dublin", "Cork"] }).filters.city).toBe("Dublin");
  });

  it("truncates an over-long value instead of rejecting the search", () => {
    const { form } = parseSearchParams({ q: "x".repeat(500) });
    expect(form.q).toHaveLength(120);
  });

  it("keeps the raw values so the form can be repopulated", () => {
    const { form } = parseSearchParams({ q: "market", city: "Dublin", from: "2026-12-01" });
    expect(form).toMatchObject({ q: "market", city: "Dublin", fromDate: "2026-12-01" });
  });

  it("passes a cursor through", () => {
    expect(parseSearchParams({ cursor: "abc" }).filters.cursor).toBe("abc");
  });

  it("filters by a known category, and drops an unknown one without losing the others", () => {
    const known = parseSearchParams({ category: "COMEDY", city: "Dublin" });
    expect(known.filters).toMatchObject({ category: "COMEDY", city: "Dublin" });
    expect(known.form.category).toBe("COMEDY");
    expect(known.hasFilters).toBe(true);

    const unknown = parseSearchParams({ category: "OPERA", city: "Dublin" });
    expect(unknown.filters).not.toHaveProperty("category");
    expect(unknown.filters.city).toBe("Dublin");
    expect(unknown.form.category).toBe("");
  });

  it("keeps the category in the query string", () => {
    const { form } = parseSearchParams({ category: "MUSIC" });
    expect(new URLSearchParams(searchQueryString(form).slice(1)).get("category")).toBe("MUSIC");
  });

  it("does not treat a cursor alone as an active filter", () => {
    // Otherwise page two would always offer "Clear filters".
    expect(parseSearchParams({ cursor: "abc" }).hasFilters).toBe(false);
  });
});

describe("searchQueryString", () => {
  const form = {
    q: "market",
    city: "Dublin",
    venue: "",
    fromDate: "2026-12-01",
    toDate: "",
    sellerId: "",
    category: "",
  };

  it("preserves active filters and adds the cursor", () => {
    const qs = searchQueryString(form, "CURSOR");
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get("q")).toBe("market");
    expect(params.get("city")).toBe("Dublin");
    expect(params.get("from")).toBe("2026-12-01");
    expect(params.get("cursor")).toBe("CURSOR");
  });

  it("omits empty fields", () => {
    const params = new URLSearchParams(searchQueryString(form).slice(1));
    expect(params.has("venue")).toBe(false);
    expect(params.has("to")).toBe(false);
    expect(params.has("cursor")).toBe(false);
  });

  it("returns an empty string when nothing is set", () => {
    expect(
      searchQueryString({ q: "", city: "", venue: "", fromDate: "", toDate: "", sellerId: "", category: "" }),
    ).toBe("");
  });

  it("round-trips through parseSearchParams", () => {
    const qs = searchQueryString(form, "CURSOR");
    const params = Object.fromEntries(new URLSearchParams(qs.slice(1)).entries());
    const reparsed = parseSearchParams(params);
    expect(reparsed.form.q).toBe("market");
    expect(reparsed.form.city).toBe("Dublin");
    expect(reparsed.filters.cursor).toBe("CURSOR");
  });
});
