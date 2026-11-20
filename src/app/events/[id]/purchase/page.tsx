import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EmptyState, NotImplementedNotice } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db/client";
import { getPublishedEvent } from "@/features/events/event-store";
import { eventPageReads } from "@/features/events/server-deps";
import { formatEventDate, formatXrp, isPastEvent } from "@/features/events/event-formatting";
import { tierPurchaseStates } from "@/features/events/purchase-eligibility";

export const metadata = { title: "Buy a ticket" };

/**
 * The offer a buyer selected, confirmed before any wallet step (XRPL-019).
 *
 * Eligibility is re-checked here rather than trusted from the previous page: an
 * offer can be taken by someone else between the two requests, so arriving with
 * a stale link must say so instead of starting a purchase that would fail.
 *
 * Wallet readiness and the fee estimate are XRPL-030; the approval and
 * acceptance themselves are XRPL-031.
 */
export default async function PurchasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tier?: string }>;
}) {
  const [{ id }, { tier: tierId }] = await Promise.all([params, searchParams]);
  const db = getDb();

  const event = await getPublishedEvent(db, id);
  if (!event) notFound();

  const reads = eventPageReads();
  const [availability, offers] = await Promise.all([
    reads.availability(id).catch(() => null),
    reads.primaryOffers(id).catch(() => null),
  ]);

  const backToEvent = (
    <Link
      href={`/events/${id}`}
      className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
    >
      Back to the event
    </Link>
  );

  if (availability === null || offers === null) {
    return (
      <>
        <PageHeader title="Buy a ticket" />
        <EmptyState
          title="Tickets cannot be checked right now"
          description="Availability could not be read. Nothing has been reserved or charged — try again shortly."
          action={backToEvent}
        />
      </>
    );
  }

  const states = tierPurchaseStates(availability.tiers, offers, {
    isPublished: true,
    hasStarted: isPastEvent(event.startsAt),
  });
  const selected = states.find((state) => state.tierId === tierId);

  if (!selected) {
    return (
      <>
        <PageHeader title="Buy a ticket" />
        <EmptyState
          title="That ticket type is not available"
          description="It may have been removed or renamed. Choose a ticket type on the event page."
          action={backToEvent}
        />
      </>
    );
  }

  if (!selected.canBuy || !selected.offer) {
    return (
      <>
        <PageHeader title="Buy a ticket" description={event.title} />
        <EmptyState
          title={selected.blockedMessage ?? "This ticket is not on sale"}
          description="Someone may have bought the last one while you were deciding. Nothing has been charged."
          action={backToEvent}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Buy a ticket"
        description={`${event.title} · ${formatEventDate(event.startsAt)}`}
        actions={backToEvent}
      />

      <section
        aria-labelledby="order-heading"
        className="max-w-xl rounded-card border border-border bg-surface-raised p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="order-heading" className="text-lg font-semibold">
            {selected.name}
          </h2>
          <Badge tone="positive">On sale</Badge>
        </div>

        <dl className="mt-4 flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Ticket</dt>
            <dd>
              {selected.name} · serial #{selected.offer.serial}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Venue</dt>
            <dd>
              {event.venue}, {event.city}
            </dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-3">
            <dt className="font-medium">Price</dt>
            <dd className="text-lg font-semibold">{formatXrp(selected.offer.amountDrops)}</dd>
          </div>
        </dl>

        <p className="mt-4 text-sm text-muted">
          The network fee is added by your wallet when you approve the transaction, so
          the total shown there may be marginally higher.
        </p>
      </section>

      <div className="mt-6 max-w-xl">
        <NotImplementedNotice
          title="Wallet approval and purchase"
          blockedBy="XRPL-030 (wallet readiness and fee estimate) and XRPL-031 (accepting the offer with your wallet)"
        />
      </div>
    </>
  );
}
