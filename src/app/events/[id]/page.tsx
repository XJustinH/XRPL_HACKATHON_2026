import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { safeExternalUrl } from "@/contracts";
import type { PrimaryAvailability } from "@/contracts/inventory";
import type { PrimaryOfferListing } from "@/contracts/xrpl";
import type { ResaleEligibility, ResaleListing } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { getDb } from "@/lib/db/client";
import { getCurrentSession } from "@/lib/auth/current-session";
import { eventPageReads } from "@/features/events/server-deps";
import { getPublishedEvent } from "@/features/events/event-store";
import { formatEventDate, formatXrp, isPastEvent } from "@/features/events/event-formatting";
import { cityBrowseHref, venueBrowseHref } from "@/features/discovery/browse-links";
import { tierPurchaseStates } from "@/features/events/purchase-eligibility";
import { TicketSelection } from "@/features/events/ticket-selection";
import { isWishlisted } from "@/features/profiles/wishlist";
import { WishlistButton } from "@/features/profiles/wishlist-button";
import { EventReviews } from "@/features/reviews/event-reviews";
import { ResaleListingCard } from "@/features/transfers/resale-listing-card";

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
  const [session, availability, offers, resale] = await Promise.all([
    getCurrentSession().catch(() => null),
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
      .resale(id)
      .catch((error: unknown) => {
        console.error("[events] resale listings unavailable", error);
        return null;
      }),
  ]);

  // Saving is independent of buying, so this is offered whatever the
  // availability or wallet state (XRPL-062).
  const saved = session
    ? await isWishlisted(db, session.userId, id).catch(() => false)
    : false;

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

      {session ? (
        <div className="mt-6">
          <WishlistButton
            eventId={event.id}
            initialSaved={saved}
            eventTitle={event.title}
          />
        </div>
      ) : null}

      {/* Told before clicking through, so a disconnected buyer does not reach
          the purchase step only to be stopped there (XRPL-030). */}
      {!session?.walletAddress && !hasStarted && (offers?.length ?? 0) > 0 ? (
        <p className="mt-6 flex flex-wrap items-center gap-3 rounded-card border border-border bg-accent-soft px-5 py-4 text-sm text-accent">
          <span>You will need a connected wallet to buy a ticket.</span>
          <Link href="/connect" className="font-semibold underline">
            Connect your wallet
          </Link>
        </p>
      ) : null}

      <PrimarySection
        eventId={event.id}
        availability={availability}
        offers={offers}
        hasStarted={hasStarted}
      />

      <ResaleSection eventId={event.id} resale={resale} />

      {/* Agent D (XRPL-079): reviews, which only people checked in at this event can write. */}
      <div className="mt-10">
        <EventReviews eventId={event.id} />
      </div>

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

/** How many resale listings the event page shows before linking to the full list. */
const RESALE_PREVIEW = 4;

/**
 * Resale tickets for this event (XRPL-038), only when the in-app resale rule allows them. The
 * listings come through the rule too, so a hidden or stale offer never shows here.
 */
function ResaleSection({
  eventId,
  resale,
}: {
  eventId: string;
  resale: { eligibility: ResaleEligibility; offers: ResaleListing[] } | null;
}) {
  const shown = resale?.offers.slice(0, RESALE_PREVIEW) ?? [];
  const more = (resale?.offers.length ?? 0) - shown.length;

  return (
    <section aria-labelledby="resale-heading" className="mt-10">
      <h2 id="resale-heading" className="mb-4 text-lg font-semibold">
        Tickets from other fans
      </h2>

      {resale === null ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">
          Resale availability could not be checked just now.
        </p>
      ) : !resale.eligibility.isPublicResaleAllowed ? (
        <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">
          {resale.eligibility.message}
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">{resale.eligibility.message}</p>
          {shown.length === 0 ? (
            <p className="rounded-card border border-border bg-surface px-5 py-4 text-sm text-muted">
              No one has listed a ticket for resale yet. Check back later.
            </p>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2">
              {shown.map((listing) => (
                <li key={listing.offerId}>
                  <ResaleListingCard listing={listing} showEvent={false} />
                </li>
              ))}
            </ul>
          )}
          {more > 0 ? (
            <Link
              href={`/resale?eventId=${encodeURIComponent(eventId)}`}
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              See all {resale.offers.length} resale tickets
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}
