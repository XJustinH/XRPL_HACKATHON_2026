import Link from "next/link";
import type { EventView, Page } from "@/contracts";
import { EmptyState, NotImplementedNotice } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db/client";
import { listPublishedEvents } from "@/features/events/event-store";
import { EventCard } from "@/features/events/event-card";
import {
  parseSearchParams,
  searchQueryString,
  type SearchParams,
} from "@/features/discovery/search-filters";

export const metadata = { title: "Search" };

/**
 * XRPL-059 — search and filter published events.
 *
 * The form submits with GET so the URL holds the whole query: results are
 * shareable, the back button behaves, and no client-side state is needed.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { filters, form, hasFilters } = parseSearchParams(params);

  let page: Page<EventView> | null = null;
  try {
    page = await listPublishedEvents(getDb(), filters);
  } catch (error) {
    console.error("[discovery] event search failed", error);
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base";
  const labelClass = "block text-sm font-medium";

  return (
    <>
      <PageHeader
        title="Search events"
        description="Find published events by name, city, venue, date or organiser."
      />

      <form
        method="GET"
        action="/search"
        aria-labelledby="filters-heading"
        className="rounded-card border border-border bg-surface-raised p-5"
      >
        <h2 id="filters-heading" className="text-sm font-semibold">
          Filters
        </h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="q" className={labelClass}>
              Search
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={form.q}
              maxLength={120}
              placeholder="Event name or description"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="city" className={labelClass}>
              City
            </label>
            <input
              id="city"
              name="city"
              type="text"
              defaultValue={form.city}
              maxLength={80}
              autoComplete="address-level2"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="venue" className={labelClass}>
              Venue
            </label>
            <input
              id="venue"
              name="venue"
              type="text"
              defaultValue={form.venue}
              maxLength={160}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="from" className={labelClass}>
              From date
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={form.fromDate}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="to" className={labelClass}>
              To date
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={form.toDate}
              className={inputClass}
            />
          </div>
        </div>

        {/* Carried through the form so an organiser-filtered search survives
            re-submission from this page (XRPL-060 links in with it). */}
        {form.sellerId ? (
          <input type="hidden" name="sellerId" value={form.sellerId} />
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Apply filters
          </button>
          {hasFilters ? (
            <Link
              href="/search"
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <div className="mt-6">
        <NotImplementedNotice
          title="Filter by category"
          blockedBy="an Event.category column, which the schema does not have yet; the category vocabulary already exists from XRPL-058"
        />
      </div>

      <section aria-labelledby="results-heading" className="mt-8">
        <h2 id="results-heading" className="mb-4 text-lg font-semibold">
          {page === null
            ? "Results"
            : `${page.items.length} ${page.items.length === 1 ? "event" : "events"}${
                page.nextCursor ? " on this page" : ""
              }`}
        </h2>

        {page === null ? (
          <div
            role="alert"
            className="rounded-card border border-border bg-critical-soft px-5 py-6 text-center text-sm text-critical"
          >
            <p className="font-semibold">Search is unavailable</p>
            <p className="mt-1">This is a problem on our side. Try again shortly.</p>
          </div>
        ) : page.items.length === 0 ? (
          <EmptyState
            title={hasFilters ? "No events match these filters" : "No events on sale yet"}
            description={
              hasFilters
                ? "Try a wider date range, a different city, or clear the filters to see everything."
                : "Published events with an upcoming date will appear here."
            }
            action={
              hasFilters ? (
                <Link
                  href="/search"
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
                >
                  Clear filters
                </Link>
              ) : null
            }
          />
        ) : (
          <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {page.items.map((event) => (
                <li key={event.id}>
                  <EventCard event={event} />
                </li>
              ))}
            </ul>

            {page.nextCursor ? (
              <nav aria-label="Pagination" className="mt-8 flex justify-center">
                <Link
                  href={`/search${searchQueryString(form, page.nextCursor)}`}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
                >
                  Next page
                </Link>
              </nav>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
