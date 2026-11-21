import Link from "next/link";
import type { EventView, Page } from "@/contracts";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { listPublishedEvents } from "@/features/events/event-store";
import { EventCard } from "@/features/events/event-card";
import { getCustomerPreferences } from "@/features/profiles/customer-preferences";
import { listFollowedSellerIds } from "@/features/profiles/follows";
import { hasRankingSignals, rankEvents, type ScoredEvent } from "@/features/discovery/ranking";

/**
 * XRPL-018 — public listing of published, upcoming events.
 * XRPL-089 — ordered by declared interests and chosen city when they exist.
 *
 * Paging is a plain link with a cursor query parameter, so it works without
 * client-side JavaScript and each page is shareable.
 *
 * Ranking only reorders the page; `?all=1` turns it off entirely. Nothing is
 * ever filtered out by a preference, so the full list is always reachable.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; all?: string }>;
}) {
  const { cursor, all } = await searchParams;
  const rankingOff = all === "1";

  let page: Page<EventView> | null = null;
  try {
    page = await listPublishedEvents(getDb(), { cursor });
  } catch (error) {
    // A listing failure is shown in place; it must not blank the whole page.
    console.error("[events] could not load published events", error);
  }

  const session = rankingOff ? null : await getCurrentSession().catch(() => null);
  const [preferences, followedSellerIds] = session
    ? await Promise.all([
        getCustomerPreferences(getDb(), session.userId).catch(() => null),
        listFollowedSellerIds(getDb(), session.userId).catch(() => []),
      ])
    : [null, []];

  const signals = {
    interests: preferences?.interests ?? [],
    city: preferences?.city ?? null,
    followedSellerIds,
  };
  const ranking = !rankingOff && hasRankingSignals(signals);
  const items: ScoredEvent[] = page
    ? ranking
      ? rankEvents(page.items, signals)
      : page.items.map((event) => ({ event, score: 0, reasons: [] }))
    : [];

  return (
    <>
      <PageHeader
        title="Discover events"
        description="Tickets here are NFTs on the XRP Ledger Testnet. Ownership and transfers are verified against the ledger, not just recorded by this site."
      />

      {ranking ? (
        <p className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-accent-soft px-5 py-4 text-sm text-accent">
          <span>
            Ordered by your interests
            {signals.city ? ` and events in ${signals.city}` : null}. Nothing is hidden.
          </span>
          <span className="flex gap-4">
            <Link href="/?all=1" className="font-semibold underline">
              Show newest first
            </Link>
            <Link href="/preferences" className="font-semibold underline">
              Change
            </Link>
          </span>
        </p>
      ) : null}

      {rankingOff ? (
        <p className="mb-6 text-sm text-muted">
          Showing every event by date.{" "}
          <Link href="/" className="font-medium text-accent underline">
            Use my interests instead
          </Link>
        </p>
      ) : null}

      {page === null ? (
        <div
          role="alert"
          className="rounded-card border border-border bg-critical-soft px-5 py-6 text-center text-sm text-critical"
        >
          <p className="font-semibold">Events could not be loaded</p>
          <p className="mt-1">
            This is a problem on our side, not with your connection. Refresh to try
            again.
          </p>
        </div>
      ) : page.items.length === 0 ? (
        <EmptyState
          title={cursor ? "No more events" : "No events on sale yet"}
          description={
            cursor
              ? "You have reached the end of the list."
              : "Published events with an upcoming date will appear here. Organisers can create one from the events area."
          }
          action={
            cursor ? (
              <Link
                href="/"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Back to the first page
              </Link>
            ) : (
              <Link
                href="/seller/events/new"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
              >
                Create an event
              </Link>
            )
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map(({ event, reasons }) => (
              <li key={event.id}>
                <EventCard event={event} />
                {/* Why this is where it is — the order has to be explainable. */}
                {reasons.length > 0 ? (
                  <p className="mt-2 px-1 text-xs text-muted">{reasons.join(" · ")}</p>
                ) : null}
              </li>
            ))}
          </ul>

          {page.nextCursor ? (
            <nav aria-label="Pagination" className="mt-8 flex justify-center">
              <Link
                href={`/?cursor=${encodeURIComponent(page.nextCursor)}${rankingOff ? "&all=1" : ""}`}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
              >
                Next page
              </Link>
            </nav>
          ) : null}

          {ranking ? (
            <p className="mt-6 text-sm text-muted">
              Order is based only on the interests and city you chose. We never use your
              device location or track what you browse.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
