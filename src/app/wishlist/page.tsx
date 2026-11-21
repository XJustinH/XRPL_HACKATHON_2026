import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { listWishlistEvents, type WishlistEntries } from "@/features/profiles/wishlist";
import { EventCard } from "@/features/events/event-card";

export const metadata = { title: "Saved events" };

/**
 * XRPL-062 — events a customer has saved.
 *
 * Saving is independent of owning a ticket: an event stays saved after a
 * purchase, and nothing here implies the customer is going.
 */
export default async function WishlistPage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Saved events" />
        <EmptyState
          title="Sign in to save events"
          description="Save events you are interested in and come back to them later."
          action={
            <Link
              href="/onboarding"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Get started
            </Link>
          }
        />
      </>
    );
  }

  let entries: WishlistEntries | null = null;
  try {
    entries = await listWishlistEvents(getDb(), session.userId);
  } catch (error) {
    console.error("[wishlist] could not load saved events", error);
  }

  if (entries === null) {
    return (
      <>
        <PageHeader title="Saved events" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your saved events could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  const total = entries.upcoming.length + entries.past.length;

  if (total === 0) {
    return (
      <>
        <PageHeader title="Saved events" />
        <EmptyState
          title="You have not saved any events"
          description="Use Save on an event page to keep it here. Saving does not buy a ticket."
          action={
            <Link
              href="/"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Find an event
            </Link>
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Saved events"
        description="Events you are keeping an eye on. Saving one does not buy a ticket or hold a place."
      />

      {entries.upcoming.length > 0 ? (
        <section aria-labelledby="upcoming-heading">
          <h2 id="upcoming-heading" className="mb-4 text-lg font-semibold">
            Still to come
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {entries.upcoming.map((event) => (
              <li key={event.id}>
                <EventCard event={event} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Kept rather than silently dropped: disappearing would look like the
          save had been lost. */}
      {entries.past.length > 0 ? (
        <section aria-labelledby="past-heading" className="mt-10">
          <h2 id="past-heading" className="mb-4 text-lg font-semibold">
            Already happened
          </h2>
          <ul className="grid gap-4 opacity-75 sm:grid-cols-2 lg:grid-cols-3">
            {entries.past.map((event) => (
              <li key={event.id}>
                <EventCard event={event} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
