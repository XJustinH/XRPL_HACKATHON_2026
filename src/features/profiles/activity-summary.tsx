import Link from "next/link";
import type { TicketView } from "@/contracts";
import type { AttendedEvent } from "@/features/checkin/attendance-history";
import { formatEventDate } from "@/features/events/event-formatting";

/**
 * Customer activity summary for the profile page (XRPL-056): upcoming events from the tickets the
 * wallet holds, events attended, followed sellers and wishlist.
 *
 * `null` for a list means it couldn't be loaded; that is shown as "couldn't check", never as empty.
 */

export type UpcomingEvent = {
  eventId: string;
  title: string;
  startsAt: string;
  venue: string;
  city: string;
  tickets: number;
};

/** Groups held tickets by event: future events only, soonest first. */
export function summariseUpcoming(tickets: readonly TicketView[], now: Date = new Date()): UpcomingEvent[] {
  const byEvent = new Map<string, UpcomingEvent>();
  for (const t of tickets) {
    if (new Date(t.event.startsAt).getTime() <= now.getTime()) continue;
    const existing = byEvent.get(t.event.id);
    if (existing) {
      existing.tickets += 1;
      continue;
    }
    byEvent.set(t.event.id, {
      eventId: t.event.id,
      title: t.event.title,
      startsAt: t.event.startsAt,
      venue: t.event.venue,
      city: t.event.city,
      tickets: 1,
    });
  }
  return [...byEvent.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const SHOWN = 5;

export function ActivitySummary({
  hasWallet,
  upcoming,
  attended,
}: {
  hasWallet: boolean;
  upcoming: UpcomingEvent[] | null;
  attended: AttendedEvent[] | null;
}) {
  return (
    <section aria-labelledby="activity-heading" className="mt-6 rounded-card border border-border bg-surface-raised p-5">
      <h2 id="activity-heading" className="text-lg font-semibold">
        Your activity
      </h2>

      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <Part title="Upcoming events">
          {!hasWallet ? (
            <p className="text-sm text-muted">
              <Link href="/connect" className="font-medium text-accent underline">
                Connect your wallet
              </Link>{" "}
              to see the tickets it holds.
            </p>
          ) : upcoming === null ? (
            <p className="text-sm text-muted">Couldn&apos;t check your wallet just now. Try again shortly.</p>
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-muted">
              No tickets for upcoming events.{" "}
              <Link href="/" className="font-medium text-accent underline">
                Find an event
              </Link>
            </p>
          ) : (
            <>
              <EventList
                items={upcoming.slice(0, SHOWN).map((e) => ({
                  key: e.eventId,
                  href: `/events/${e.eventId}`,
                  title: e.title,
                  detail: `${formatEventDate(e.startsAt)} · ${e.venue}, ${e.city}`,
                  note: e.tickets === 1 ? "1 ticket" : `${e.tickets} tickets`,
                }))}
              />
              <Link href="/tickets" className="mt-3 inline-block text-sm font-medium text-accent underline">
                View all my tickets
              </Link>
            </>
          )}
        </Part>

        <Part title="Events you attended">
          {attended === null ? (
            <p className="text-sm text-muted">Couldn&apos;t load your history just now.</p>
          ) : attended.length === 0 ? (
            <p className="text-sm text-muted">None yet. Events appear here once you&apos;re checked in at the door.</p>
          ) : (
            <EventList
              items={attended.slice(0, SHOWN).map((e) => ({
                key: e.eventId,
                href: `/events/${e.eventId}`,
                title: e.title,
                detail: `${formatEventDate(e.startsAt)} · ${e.venue}, ${e.city}`,
                note: "Attended",
              }))}
            />
          )}
        </Part>

        <Part title="Sellers you follow">
          <p className="text-sm text-muted">Sellers you follow will appear here once following is available.</p>
        </Part>

        <Part title="Wishlist">
          <p className="text-sm text-muted">Events you save will appear here once the wishlist is available.</p>
        </Part>
      </div>
    </section>
  );
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function EventList({ items }: { items: { key: string; href: string; title: string; detail: string; note: string }[] }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((i) => (
        <li key={i.key} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <Link href={i.href} className="font-medium hover:underline">
              {i.title}
            </Link>
            <p className="text-xs text-muted">{i.detail}</p>
          </div>
          <span className="shrink-0 text-xs text-muted">{i.note}</span>
        </li>
      ))}
    </ul>
  );
}
