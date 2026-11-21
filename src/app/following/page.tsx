import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import {
  listEventsFromFollowedSellers,
  listFollowedSellers,
} from "@/features/profiles/follows";
import { EventCard } from "@/features/events/event-card";

export const metadata = { title: "Following" };

/**
 * XRPL-061 — the accounts a customer follows and their upcoming events.
 *
 * The event feed reuses the public listing's filters, so a draft or a finished
 * event cannot appear here.
 */
export default async function FollowingPage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Following" />
        <EmptyState
          title="Sign in to follow organisers"
          description="Follow artists, venues and organisers to see their new events in one place."
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

  const db = getDb();
  let sellers: Awaited<ReturnType<typeof listFollowedSellers>> | null = null;
  let events: Awaited<ReturnType<typeof listEventsFromFollowedSellers>> = [];
  try {
    [sellers, events] = await Promise.all([
      listFollowedSellers(db, session.userId),
      listEventsFromFollowedSellers(db, session.userId),
    ]);
  } catch (error) {
    console.error("[follows] could not load followed accounts", error);
  }

  if (sellers === null) {
    return (
      <>
        <PageHeader title="Following" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your followed accounts could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  if (sellers.length === 0) {
    return (
      <>
        <PageHeader title="Following" />
        <EmptyState
          title="You are not following anyone yet"
          description="Follow an organiser from their page and their upcoming events will show up here."
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
        title="Following"
        description={`${sellers.length} ${sellers.length === 1 ? "account" : "accounts"} you follow.`}
      />

      <section aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className="mb-4 text-lg font-semibold">
          Accounts
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sellers.map((seller) => (
            <li
              key={seller.id}
              className="rounded-card border border-border bg-surface-raised p-4"
            >
              <h3 className="font-semibold">
                <Link href={`/sellers/${seller.id}`} className="hover:text-accent">
                  {seller.displayName}
                </Link>
              </h3>
              <p className="mt-1 text-sm text-muted">
                {seller.city ? `${seller.city} · ` : null}
                {seller.upcomingEventCount}{" "}
                {seller.upcomingEventCount === 1 ? "upcoming event" : "upcoming events"}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="feed-heading" className="mt-10">
        <h2 id="feed-heading" className="mb-4 text-lg font-semibold">
          Upcoming from accounts you follow
        </h2>
        {events.length === 0 ? (
          <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
            None of the accounts you follow have an upcoming event on sale right now.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => (
              <li key={event.id}>
                <EventCard event={event} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
