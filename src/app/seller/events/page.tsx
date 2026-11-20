import Link from "next/link";
import { EVENT_MANAGER_ROLES, type EventView } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { listSellerEvents } from "@/features/events/event-store";
import {
  formatEventDate,
  formatXrp,
  isPastEvent,
  lowestPriceDrops,
} from "@/features/events/event-formatting";

export const metadata = { title: "Manage events" };

function EventRow({ event }: { event: EventView }) {
  const fromPrice = lowestPriceDrops(event.tiers);
  const totalSupply = event.tiers.reduce((sum, tier) => sum + tier.totalSupply, 0);
  const past = isPastEvent(event.startsAt);

  return (
    <li className="rounded-card border border-border bg-surface-raised p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">
              <Link href={`/seller/events/${event.id}`} className="hover:underline">
                {event.title}
              </Link>
            </h3>
            <Badge tone={event.status === "PUBLISHED" ? "positive" : "neutral"}>
              {event.status === "PUBLISHED" ? "Published" : "Draft"}
            </Badge>
            {past ? <Badge tone="caution">Past</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {formatEventDate(event.startsAt)} · {event.venue}, {event.city}
          </p>
          <p className="mt-2 text-sm text-muted">
            {event.tiers.length === 0 ? (
              "No ticket tiers yet"
            ) : (
              <>
                {event.tiers.length} {event.tiers.length === 1 ? "tier" : "tiers"} ·{" "}
                {totalSupply} {totalSupply === 1 ? "ticket" : "tickets"}
                {fromPrice ? <> · from {formatXrp(fromPrice)}</> : null}
              </>
            )}
          </p>
        </div>
        <Link
          href={`/seller/events/${event.id}`}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface"
        >
          {event.tiers.length === 0 ? "Add tickets" : "Manage tickets"}
        </Link>
      </div>
      {/* Agent D's organiser tools (XRPL-021, XRPL-048, XRPL-077). */}
      <nav aria-label={`Organiser tools for ${event.title}`} className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href={`/organiser/events/${event.id}/inventory`} className="font-medium text-accent hover:underline">
          Inventory
        </Link>
        <Link href={`/organiser/events/${event.id}/checkin`} className="font-medium text-accent hover:underline">
          Door check-in
        </Link>
        <Link href={`/organiser/events/${event.id}/analytics`} className="font-medium text-accent hover:underline">
          Analytics
        </Link>
      </nav>
    </li>
  );
}

/**
 * XRPL-015 — seller management view.
 *
 * Lists only the signed-in account's own events, drafts included. Editing,
 * tiers and publishing are added by XRPL-016 and XRPL-017.
 */
export default async function SellerEventsPage() {
  const session = await getCurrentSession();
  const canManage =
    !!session &&
    !!session.onboardedAt &&
    (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canManage) {
    return (
      <>
        <PageHeader title="Manage events" />
        <EmptyState
          title={session ? "Your account can't manage events" : "Sign in to manage events"}
          description={
            session
              ? "Event management is available to seller and organiser accounts."
              : "Create a seller profile, or use a demo seller account, to publish events."
          }
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

  let events: EventView[] = [];
  let loadFailed = false;
  try {
    events = await listSellerEvents(getDb(), session.userId);
  } catch (error) {
    // A listing failure must not take the whole page down; the seller still
    // needs the link to create an event.
    console.error("[events] could not load seller events", error);
    loadFailed = true;
  }

  return (
    <>
      <PageHeader
        title="Manage events"
        description="Your events, including drafts that are not yet public."
        actions={
          <Link
            href="/seller/events/new"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Create event
          </Link>
        }
      />

      {loadFailed ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your events could not be loaded. Refresh to try again.
        </p>
      ) : events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Create your first event draft. You can add ticket tiers and publish it when the details are final."
          action={
            <Link
              href="/seller/events/new"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Create event
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ul>
      )}
    </>
  );
}
