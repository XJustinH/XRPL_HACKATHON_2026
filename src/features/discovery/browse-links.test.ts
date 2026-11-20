import { describe, expect, it } from "vitest";
import { cityBrowseHref, organiserBrowseHref, venueBrowseHref } from "./browse-links";
import { parseSearchParams } from "./search-filters";
import { listPublishedEvents } from "@/features/events/event-store";

/** Reads a generated href back through the search page's own parser. */
function parseHref(href: string) {
  const query = href.slice(href.indexOf("?") + 1);
  return parseSearchParams(Object.fromEntries(new URLSearchParams(query).entries()));
}

describe("venueBrowseHref", () => {
  it("scopes a search to the venue", () => {
    const { form, filters } = parseHref(venueBrowseHref("Vicar Street"));
    expect(form.venue).toBe("Vicar Street");
    expect(filters.venue).toBe("Vicar Street");
  });

  it("includes the city, so same-named venues elsewhere are excluded", () => {
    const { filters } = parseHref(venueBrowseHref("The Academy", "Dublin"));
    expect(filters.venue).toBe("The Academy");
    expect(filters.city).toBe("Dublin");
  });

  it("escapes characters that would otherwise break the query string", () => {
    const href = venueBrowseHref("Smith & Sons / Hall", "Dún Laoghaire");
    expect(href).not.toContain(" ");
    const { filters } = parseHref(href);
    expect(filters.venue).toBe("Smith & Sons / Hall");
    expect(filters.city).toBe("Dún Laoghaire");
  });

  it("omits an empty venue or city rather than filtering on blank", () => {
    const { hasFilters } = parseHref(venueBrowseHref("   ", "  "));
    expect(hasFilters).toBe(false);
  });
});

describe("cityBrowseHref", () => {
  it("scopes a search to the city", () => {
    expect(parseHref(cityBrowseHref("Cork")).filters.city).toBe("Cork");
  });
});

describe("organiserBrowseHref", () => {
  const id = "3f1a8b0c-0000-4000-8000-000000000000";

  it("scopes a search to the organiser", () => {
    expect(parseHref(organiserBrowseHref(id)).filters.sellerId).toBe(id);
  });

  it("encodes the id", () => {
    expect(organiserBrowseHref("a b&c")).toBe("/search?sellerId=a%20b%26c");
  });
});

describe("browsing by venue or organiser cannot expose a draft", () => {
  type FindManyArgs = { where: Record<string, unknown>; take: number };

  function stubDb() {
    const calls: FindManyArgs[] = [];
    const db = {
      event: {
        findMany: async (args: FindManyArgs) => {
          calls.push(args);
          return [];
        },
      },
    } as never;
    return { db, calls };
  }

  const NOW = new Date("2026-11-20T12:00:00.000Z");

  it("still filters to published upcoming events for a venue link", async () => {
    // The links route through the same query as the public search, so there is
    // no second listing path that could forget the status check.
    const { filters } = parseHref(venueBrowseHref("Vicar Street", "Dublin"));
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { ...filters, now: NOW });

    expect(calls[0]!.where.status).toBe("PUBLISHED");
    expect(calls[0]!.where.startsAt).toEqual({ gt: NOW });
  });

  it("still filters to published upcoming events for an organiser link", async () => {
    const id = "3f1a8b0c-0000-4000-8000-000000000000";
    const { filters } = parseHref(organiserBrowseHref(id));
    const { db, calls } = stubDb();
    await listPublishedEvents(db, { ...filters, now: NOW });

    expect(calls[0]!.where.status).toBe("PUBLISHED");
    expect(calls[0]!.where.sellerId).toBe(id);
  });
});
