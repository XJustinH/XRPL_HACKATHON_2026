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
/** The first page's banner: what this is, where to start, and why a ticket here is different. */
function Hero({ signedIn }: { signedIn: boolean }) {
  const points = [
    ["Held in your wallet", "Your ticket is an NFT you own. You approve every step in Xaman."],
    ["Checked against the ledger", "Sales and ownership count only once the ledger has validated them."],
    ["Yours to pass on", "Resell, sell to a friend or gift a ticket, wallet to wallet."],
  ];
  return (
    <section className="relative mb-10 overflow-hidden rounded-card border border-border bg-surface-raised px-6 py-10 sm:px-10 sm:py-14">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-16 size-80 rounded-full bg-glow/25 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-28 -left-10 size-80 rounded-full bg-accent/20 blur-3xl"
      />
      <div className="relative">
        <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-positive" />
          NFT ticketing on the XRP Ledger Testnet
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Discover events</h1>
        <p className="mt-4 max-w-2xl text-base text-muted sm:text-lg">
          Tickets here are NFTs on the XRP Ledger Testnet. Ownership and transfers are verified against the
          ledger, not just recorded by this site.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/search"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Search events
          </Link>
          <Link
            href={signedIn ? "/resale" : "/onboarding"}
            className="rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-semibold hover:bg-canvas"
          >
            {signedIn ? "Browse resale tickets" : "Get started"}
          </Link>
        </div>
        <ul className="mt-8 grid gap-4 text-sm sm:grid-cols-3">
          {points.map(([title, text]) => (
            <li key={title} className="rounded-lg border border-border bg-surface px-4 py-3">
              <p className="font-semibold">{title}</p>
              <p className="mt-1 text-muted">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

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

  const viewer = await getCurrentSession().catch(() => null);
  const signedIn = viewer !== null;
  const session = rankingOff ? null : viewer;
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
      {cursor ? (
        <PageHeader
          title="Discover events"
          description="Tickets here are NFTs on the XRP Ledger Testnet. Ownership and transfers are verified against the ledger, not just recorded by this site."
        />
      ) : (
        <Hero signedIn={signedIn} />
      )}

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
          <h2 className="mb-4 text-xl font-semibold">{cursor ? "More events" : "Upcoming events"}</h2>
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
