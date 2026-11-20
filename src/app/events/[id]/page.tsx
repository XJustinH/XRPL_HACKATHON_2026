import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { safeExternalUrl } from "@/contracts";
import type { PrimaryAvailability } from "@/contracts/inventory";
import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { ResaleEligibility } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { NotImplementedNotice } from "@/components/ui/empty-state";
import { getDb } from "@/lib/db/client";
import { eventPageReads } from "@/features/events/server-deps";
import { getPublishedEvent } from "@/features/events/event-store";
import { formatEventDate, formatXrp, isPastEvent } from "@/features/events/event-formatting";
import { cityBrowseHref, venueBrowseHref } from "@/features/discovery/browse-links";
import { tierPurchaseStates } from "@/features/events/purchase-eligibility";
import { TicketSelection } from "@/features/events/ticket-selection";

/**
 * Public event page with ticket selection (XRPL-019).
 *
 * Availability comes from the live inventory calculation (XRPL-020) and the buy
 * controls from live primary offers (XRPL-029) — never from declared tier
 * supply, which says nothing about what is actually on sale.
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
  const db = getDb();

  // A draft returns null here, so an unpublished event is a 404 for everyone.
  const event = await getPublishedEvent(db, id);
  if (!event) notFound();

  const artworkUrl = safeExternalUrl(event.artworkUrl);
  const hasStarted = isPastEvent(event.startsAt);

  /*
   * Inventory, offers and the resale rule are each allowed to fail without
   * taking the page down — the event's own details are still worth showing.
   * A failure must read as "unknown", never as "available".
   */
  const reads = eventPageReads();
  const [availability, offers, resale] = await Promise.all([
    reads
      .availability(id)
      .catch((error: unknown) => {
        console.error("[events] availability unavailable", error);
        return null;
      }),
    reads
      .primaryOffers(id)
      .catch((error: unknown) => {
        console.error("[events] primary offers unavailable", error);
        return null;
      }),
    reads
      .resaleEligibility(id)
      .catch((error: unknown) => {
        console.error("[events] resale eligibility unavailable", error);
        return null;
      }),
  ]);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
        <Link href="/" className="hover:text-ink">
          Discover
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{event.title}</span>
      </nav>

      {artworkUrl ? (
        <div className="mb-6 aspect-[16/9] w-full overflow-hidden rounded-card bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host */}
          <img src={artworkUrl} alt="" className="size-full object-cover" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{event.title}</h1>
        {hasStarted ? <Badge tone="caution">Already started</Badge> : null}
        {availability?.isSoldOut ? <Badge tone="critical">Sold out</Badge> : null}
      </div>

      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">When</dt>
          <dd className="mt-1 text-sm">{formatEventDate(event.startsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">Where</dt>
          <dd className="mt-1 text-sm">
            {/* Both route into the public search, so neither can expose a draft. */}
            <Link
              href={venueBrowseHref(event.venue, event.city)}
              className="text-accent underline"
            >
              {event.venue}
            </Link>
            {", "}
            <Link href={cityBrowseHref(event.city)} className="text-accent underline">
              {event.city}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">
            Organiser
          </dt>
          <dd className="mt-1 text-sm">
            <Link href={`/sellers/${event.seller.id}`} className="text-accent underline">
              {event.seller.displayName}
            </Link>
          </dd>
        </div>
      </dl>

      {event.description ? (
        <p className="mt-6 max-w-2xl whitespace-pre-line text-sm text-muted">
          {event.description}
        </p>
      ) : null}

      <PrimarySection
        eventId={event.id}
        availability={availability}
        offers={offers}
        hasStarted={hasStarted}
      />

      <ResaleSection eventId={event.id} resale={resale} />

      <p className="mt-8 text-sm text-muted">
        Tickets are NFTs on the XRP Ledger Testnet. Prices are in XRP, and you approve
        every purchase in your own wallet.
      </p>
    </>
  );
}

function PrimarySection({
  eventId,
  availability,
  offers,
  hasStarted,
}: {
  eventId: string;
  availability: PrimaryAvailability | null;
  offers: PrimaryOfferListing[] | null;
  hasStarted: boolean;
}) {
  return (
    <section aria-labelledby="primary-heading" className="mt-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 id="primary-heading" className="text-lg font-semibold">
          Tickets from the organiser
        </h2>
        {availability && availability.fromPriceDrops ? (
          <Badge tone="accent">From {formatXrp(availability.fromPriceDrops)}</Badge>
        ) : null}
      </div>

      {availability === null ? (
        <p
          role="alert"
          className="rounded-card border border-border bg-critical-soft px-5 py-4 text-sm text-critical"
        >
          Availability could not be read just now, so tickets cannot be bought from this
          page. Refresh to try again — nothing has been reserved or charged.
        </p>
      ) : (
        <>
          <TicketSelection
            eventId={eventId}
            tiers={tierPurchaseStates(availability.tiers, offers ?? [], {
              isPublished: true,
              hasStarted,
            })}
          />

          {offers === null ? (
            <p role="status" className="mt-3 text-sm text-caution">
              Live offers could not be read, so buying is unavailable for now. The counts
              above are still accurate.
            </p>
          ) : null}

          <p className="mt-3 text-sm text-muted">
            {availability.sold} of {availability.totalSupply} sold
            {availability.pending > 0
              ? ` · ${availability.pending} purchase${
                  availability.pending === 1 ? "" : "s"
                } in progress`
              : null}
          </p>
        </>
      )}
    </section>
  );
}

function ResaleSection({
  eventId,
  resale,
}: {
  eventId: string;
  resale: ResaleEligibility | null;
}) {
  return (
    <section aria-labelledby="resale-heading" className="mt-10">
      <h2 id="resale-heading" className="mb-4 text-lg font-semibold">
        Tickets from other fans
      </h2>

      {resale === null ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">
          Resale availability could not be checked just now.
        </p>
      ) : resale.isPublicResaleAllowed ? (
        <div className="rounded-card border border-border bg-surface-raised p-5">
          <p className="text-sm text-muted">{resale.message}</p>
          <Link
            href={`/resale?eventId=${encodeURIComponent(eventId)}`}
            className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Browse resale tickets
          </Link>
        </div>
      ) : (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">
          {resale.message}
        </p>
      )}

      <div className="mt-4">
        <NotImplementedNotice
          title="Resale listings on this page"
          blockedBy="XRPL-038, which builds the public resale marketplace on top of this eligibility rule"
        />
      </div>
    </section>
  );
}
