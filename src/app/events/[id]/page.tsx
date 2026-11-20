import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { NotImplementedNotice } from "@/components/ui/empty-state";
import { getDb } from "@/lib/db/client";
import { getPublishedEvent } from "@/features/events/event-store";
import {
  formatEventDate,
  formatXrp,
  lowestPriceDrops,
} from "@/features/events/event-formatting";

/**
 * Public event page.
 *
 * XRPL-018 needs each card to link somewhere real, so this renders the event's
 * published details and its tier prices. Ticket selection and the purchase flow
 * are XRPL-019, and wallet readiness is XRPL-030.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const event = await getPublishedEvent(getDb(), id).catch(() => null);
  return { title: event?.title ?? "Event" };
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // A draft returns null here, so an unpublished event is a 404 for everyone.
  const event = await getPublishedEvent(getDb(), id);
  if (!event) notFound();

  const fromPrice = lowestPriceDrops(event.tiers);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link href="/" className="hover:text-ink">
          Discover
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{event.title}</span>
      </nav>

      {event.artworkUrl ? (
        <div className="mb-6 aspect-[16/9] w-full overflow-hidden rounded-card bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host */}
          <img src={event.artworkUrl} alt="" className="size-full object-cover" />
        </div>
      ) : null}

      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{event.title}</h1>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">When</dt>
          <dd className="mt-1 text-sm">{formatEventDate(event.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">Where</dt>
          <dd className="mt-1 text-sm">
            {event.venue}, {event.city}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">
            Organiser
          </dt>
          <dd className="mt-1 text-sm">{event.seller.displayName}</dd>
        </div>
      </dl>

      {event.description ? (
        <p className="mt-6 max-w-2xl whitespace-pre-line text-sm text-muted">
          {event.description}
        </p>
      ) : null}

      <section aria-labelledby="tickets-heading" className="mt-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 id="tickets-heading" className="text-lg font-semibold">
            Tickets
          </h2>
          {fromPrice !== null ? (
            <Badge tone="accent">From {formatXrp(fromPrice)}</Badge>
          ) : null}
        </div>

        {event.tiers.length === 0 ? (
          <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
            No ticket tiers have been announced for this event yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {event.tiers.map((tier) => (
              <li
                key={tier.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface-raised p-4"
              >
                <div className="min-w-0">
                  <h3 className="font-semibold">{tier.name}</h3>
                  {tier.description ? (
                    <p className="mt-1 text-sm text-muted">{tier.description}</p>
                  ) : null}
                </div>
                <p className="shrink-0 font-semibold">{formatXrp(tier.priceDrops)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-6">
        <NotImplementedNotice
          title="Ticket selection and purchase"
          blockedBy="XRPL-019 (selection) and XRPL-030, which need the primary sell offers from XRPL-029"
        />
      </div>

      <p className="mt-6 text-sm text-muted">
        Prices are shown in XRP on the Testnet. Remaining availability is not shown yet —
        it comes from the live inventory calculation in XRPL-020.
      </p>
    </>
  );
}
