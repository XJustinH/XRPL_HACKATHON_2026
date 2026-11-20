import { EventQuery } from "@/contracts";
import type { EventListOptions } from "@/features/events/event-store";

/**
 * Parsing for the search form's URL parameters (XRPL-059).
 *
 * The form submits with GET, so the URL is the single source of truth: results
 * are shareable, the back button works, and the page needs no client state.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** A `datetime-local`-free date input ("2026-12-01") as a UTC day boundary. */
function dayBoundary(value: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const iso = end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

export type ParsedSearch = {
  /** Validated filters to pass to the store. */
  filters: EventListOptions;
  /** The raw values, for re-populating the form. */
  form: {
    q: string;
    city: string;
    venue: string;
    fromDate: string;
    toDate: string;
    sellerId: string;
  };
  /** True when at least one filter is active, so "Clear" can be offered. */
  hasFilters: boolean;
};

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Reads filters from URL parameters, discarding anything invalid.
 *
 * A malformed parameter is dropped rather than failing the page: a hand-edited
 * or stale URL should still show results.
 */
export function parseSearchParams(params: SearchParams): ParsedSearch {
  const form = {
    q: first(params.q).slice(0, 120),
    city: first(params.city).slice(0, 80),
    venue: first(params.venue).slice(0, 160),
    fromDate: first(params.from).slice(0, 10),
    toDate: first(params.to).slice(0, 10),
    sellerId: first(params.sellerId),
  };

  const candidate = {
    ...(form.q.trim() ? { q: form.q.trim() } : {}),
    ...(form.city.trim() ? { city: form.city.trim() } : {}),
    ...(form.venue.trim() ? { venue: form.venue.trim() } : {}),
    ...(dayBoundary(form.fromDate, false) ? { from: dayBoundary(form.fromDate, false) } : {}),
    ...(dayBoundary(form.toDate, true) ? { to: dayBoundary(form.toDate, true) } : {}),
    ...(form.sellerId.trim() ? { sellerId: form.sellerId.trim() } : {}),
    ...(first(params.cursor) ? { cursor: first(params.cursor) } : {}),
  };

  const parsed = EventQuery.safeParse(candidate);
  const filters: EventListOptions = parsed.success
    ? parsed.data
    : // Drop every filter rather than guessing which one was bad.
      EventQuery.parse({});

  const hasFilters = Boolean(
    form.q.trim() ||
      form.city.trim() ||
      form.venue.trim() ||
      form.fromDate ||
      form.toDate ||
      form.sellerId.trim(),
  );

  return { filters, form, hasFilters };
}

/** Rebuilds a query string, preserving filters while replacing the cursor. */
export function searchQueryString(
  form: ParsedSearch["form"],
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  if (form.q.trim()) params.set("q", form.q.trim());
  if (form.city.trim()) params.set("city", form.city.trim());
  if (form.venue.trim()) params.set("venue", form.venue.trim());
  if (form.fromDate) params.set("from", form.fromDate);
  if (form.toDate) params.set("to", form.toDate);
  if (form.sellerId.trim()) params.set("sellerId", form.sellerId.trim());
  if (cursor) params.set("cursor", cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}
