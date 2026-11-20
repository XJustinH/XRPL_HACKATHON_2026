import Link from "next/link";
import type { EventView, Page } from "@/contracts";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db/client";
import { listPublishedEvents } from "@/features/events/event-store";
import { EventCard } from "@/features/events/event-card";

/**
 * XRPL-018 — public listing of published, upcoming events.
 *
 * Paging is a plain link with a cursor query parameter, so it works without
 * client-side JavaScript and each page is shareable.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;

  let page: Page<EventView> | null = null;
  try {
    page = await listPublishedEvents(getDb(), { cursor });
  } catch (error) {
    // A listing failure is shown in place; it must not blank the whole page.
    console.error("[events] could not load published events", error);
  }

  return (
    <>
      <PageHeader
        title="Discover events"
        description="Tickets here are NFTs on the XRP Ledger Testnet. Ownership and transfers are verified against the ledger, not just recorded by this site."
      />

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
            {page.items.map((event) => (
              <li key={event.id}>
                <EventCard event={event} />
              </li>
            ))}
          </ul>

          {page.nextCursor ? (
            <nav aria-label="Pagination" className="mt-8 flex justify-center">
              <Link
                href={`/?cursor=${encodeURIComponent(page.nextCursor)}`}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
              >
                Next page
              </Link>
            </nav>
          ) : null}
        </>
      )}
    </>
  );
}
