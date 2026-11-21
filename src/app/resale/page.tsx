import Link from "next/link";
import { connection } from "next/server";
import { z } from "zod";

import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResaleListingCard } from "@/features/transfers/resale-listing-card";
import { listResaleListings, type ResaleListings } from "@/features/transfers/server";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Resale" };

/**
 * Public resale marketplace (XRPL-038). Lists holders' resale offers only for events whose primary
 * tickets have sold out, through the in-app resale rule (XRPL-037). `?eventId=` narrows it to one
 * event, as the event page links. Buying happens on each offer's page.
 */
export default async function ResalePage({
  searchParams,
}: {
  searchParams: Promise<{ eventId?: string | string[] }>;
}) {
  await connection();
  const eventId = z.uuid().safeParse((await searchParams).eventId);

  let result: ResaleListings | null = null;
  try {
    result = await listResaleListings(getDb(), { eventId: eventId.success ? eventId.data : null });
  } catch (error) {
    // Never show "nothing for sale" when the listings simply couldn't be read.
    console.error("[resale] could not read resale listings", error);
  }
  const event = result?.event ?? null;

  return (
    <>
      <PageHeader
        title={event ? `Resale tickets for ${event.title}` : "Resale tickets"}
        description="Tickets listed for resale by their current owners. Listings appear here only once an event's primary tickets have sold out."
      />
      {event ? (
        <p className="-mt-2 mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href={`/events/${event.id}`} className="text-accent underline">
            Back to the event
          </Link>
          <Link href="/resale" className="text-accent underline">
            See all resale tickets
          </Link>
        </p>
      ) : null}
      {result === null ? (
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-6 text-center text-sm text-critical">
          Resale listings couldn&apos;t be loaded right now. Refresh to try again.
        </p>
      ) : result.listings.length === 0 ? (
        <EmptyState
          title="No resale tickets right now"
          description={
            event?.message ?? "When an event sells out, tickets its holders list for resale appear here."
          }
          action={
            <Link href="/" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90">
              Browse events
            </Link>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {result.listings.map((listing) => (
            <li key={listing.offerId}>
              <ResaleListingCard listing={listing} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8 text-sm text-muted">{RESALE_LIMITATION_NOTICE}</p>
    </>
  );
}
