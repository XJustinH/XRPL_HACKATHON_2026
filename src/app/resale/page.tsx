import Link from "next/link";
import { connection } from "next/server";

import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import type { ResaleListing } from "@/contracts/events";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatEventDate } from "@/features/events/event-formatting";
import { listResaleListings } from "@/features/transfers/server";
import { getDb } from "@/lib/db/client";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

export const metadata = { title: "Resale" };

/**
 * Public resale marketplace (XRPL-038). Lists holders' resale offers only for events whose primary
 * tickets have sold out, through the in-app resale rule (XRPL-037). Buying happens on each offer's page.
 */
export default async function ResalePage() {
  await connection();
  let listings: ResaleListing[] | null = null;
  try {
    listings = await listResaleListings(getDb());
  } catch (error) {
    // Never show "nothing for sale" when the listings simply couldn't be read.
    console.error("[resale] could not read resale listings", error);
  }

  return (
    <>
      <PageHeader
        title="Resale tickets"
        description="Tickets listed for resale by their current owners. Listings appear here only once an event's primary tickets have sold out."
      />
      {listings === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-6 text-center text-sm text-critical">
          Resale listings couldn&apos;t be loaded right now. Refresh to try again.
        </p>
      ) : listings.length === 0 ? (
        <EmptyState
          title="No resale tickets right now"
          description="When an event sells out, tickets its holders list for resale appear here."
          action={
            <Link href="/" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90">
              Browse events
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {listings.map((listing) => (
            <li key={listing.offerId}>
              <article className="flex h-full flex-col rounded-card border border-border bg-surface-raised p-4">
                <h2 className="font-semibold leading-snug">{listing.event.title}</h2>
                <p className="mt-1 text-sm text-muted">{formatEventDate(listing.event.startsAt)}</p>
                <p className="text-sm text-muted">
                  {listing.event.venue}, {listing.event.city}
                </p>
                <p className="mt-3 text-sm">
                  <span className="font-medium">{listing.ticket.tierName}</span>
                  <span className="text-muted"> · #{listing.ticket.serial}</span>
                </p>
                <p className="mt-1 text-sm">
                  <span className="font-semibold">{formatDropsAsXrp(listing.amountDrops)} XRP</span>
                  <span className="text-muted"> · face value {formatDropsAsXrp(listing.ticket.faceValueDrops)} XRP</span>
                </p>
                <div className="mt-auto pt-4">
                  <Link
                    href={`/offers/${listing.offerId}`}
                    className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90"
                  >
                    View and buy
                  </Link>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-sm text-muted">{RESALE_LIMITATION_NOTICE}</p>
    </>
  );
}
