import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db/client";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getPublishedEvent } from "@/features/events/event-store";
import { eventPageReads, walletReads } from "@/features/events/server-deps";
import { formatEventDate, formatXrp, isPastEvent } from "@/features/events/event-formatting";
import { tierPurchaseStates } from "@/features/events/purchase-eligibility";
import {
  assessWalletReadiness,
  type WalletReadiness,
} from "@/features/events/wallet-readiness";
import { BuyTicket } from "@/features/purchase/buy-ticket";
import type { PrimaryOfferListing } from "@/contracts/xrpl";

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

  /*
   * Wallet facts are read after eligibility: there is no point checking whether
   * someone can pay for a ticket that is not for sale. A node failure leaves
   * these null, which the assessment reports as "unknown" rather than refusing
   * on the buyer's behalf.
   */
  const wallet = walletReads();
  const session = await getCurrentSession();
  const address = session?.walletAddress ?? null;

  const [accountInfo, reserves, feeDrops] = await Promise.all([
    address
      ? wallet.accountInfo(address).catch((error: unknown) => {
          console.error("[purchase] account info unavailable", error);
          return null;
        })
      : Promise.resolve(null),
    wallet.reserves().catch((error: unknown) => {
      console.error("[purchase] reserves unavailable", error);
      return null;
    }),
    wallet.feeDrops().catch((error: unknown) => {
      console.error("[purchase] fee estimate unavailable", error);
      return null;
    }),
  ]);

  const readiness = assessWalletReadiness({
    address,
    account: accountInfo,
    reserves,
    feeDrops,
    priceDrops: selected.offer.amountDrops,
    network: wallet.networkLabel(),
  });

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

        {/* What is being bought, reviewable before any wallet step. */}
        <dl className="mt-4 flex flex-col gap-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Event</dt>
            <dd className="text-right">{event.title}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Ticket</dt>
            <dd className="text-right">
              {selected.name} · serial #{selected.offer.serial}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Venue</dt>
            <dd className="text-right">
              {event.venue}, {event.city}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">NFT</dt>
            <dd className="break-all text-right font-mono text-xs">
              {selected.offer.nftokenId}
            </dd>
          </div>

          <div className="flex justify-between gap-4 border-t border-border pt-3">
            <dt className="text-muted">Ticket price</dt>
            <dd>{formatXrp(selected.offer.amountDrops)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Estimated network fee</dt>
            <dd>{readiness.feeDrops ? formatXrp(readiness.feeDrops) : "Unknown"}</dd>
          </div>
          {readiness.requiredDrops ? (
            <div className="flex justify-between gap-4 border-t border-border pt-3">
              <dt className="font-medium">Wallet needs available</dt>
              <dd className="text-lg font-semibold">{formatXrp(readiness.requiredDrops)}</dd>
            </div>
          ) : null}
        </dl>

        {readiness.requiredDrops ? (
          <p className="mt-3 text-sm text-muted">
            Includes the ticket price, the estimated fee, and the extra reserve the
            ledger requires once your account owns another NFT. The reserve is not
            spent — it stays in your wallet.
          </p>
        ) : null}
      </section>

      <WalletReadinessPanel readiness={readiness} offer={selected.offer} />
    </>
  );
}

/** Wallet state, with the next action the buyer can take. */
function WalletReadinessPanel({
  readiness,
  offer,
}: {
  readiness: WalletReadiness;
  offer: PrimaryOfferListing;
}) {
  const tone =
    readiness.status === "READY"
      ? "bg-positive-soft text-positive"
      : readiness.status === "NO_WALLET"
        ? "bg-accent-soft text-accent"
        : "bg-caution-soft text-caution";

  return (
    <section
      aria-labelledby="wallet-heading"
      className="mt-6 max-w-xl rounded-card border border-border bg-surface-raised p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="wallet-heading" className="text-lg font-semibold">
          Your wallet
        </h2>
        <Badge tone={readiness.status === "READY" ? "positive" : "caution"}>
          {readiness.network}
        </Badge>
      </div>

      <p role="status" className={`mt-3 rounded-lg px-4 py-3 text-sm ${tone}`}>
        {readiness.message}
      </p>

      {readiness.address ? (
        <dl className="mt-4 flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Address</dt>
            <dd className="break-all text-right font-mono text-xs">{readiness.address}</dd>
          </div>
          {readiness.spendableDrops ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Available to spend</dt>
              <dd>{formatXrp(readiness.spendableDrops)}</dd>
            </div>
          ) : null}
          {readiness.shortfallDrops ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Short by</dt>
              <dd className="font-semibold text-caution">
                {formatXrp(readiness.shortfallDrops)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="mt-5 border-t border-border pt-5">
        {readiness.status === "NO_WALLET" ? (
          <Link
            href="/connect"
            className="inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Connect your wallet
          </Link>
        ) : readiness.canPurchase ? (
          // Approval and acceptance with the buyer's wallet (XRPL-031, Agent B).
          <BuyTicket offer={offer} buyerAddress={readiness.address} />
        ) : (
          <button
            type="button"
            disabled
            title={readiness.message}
            className="cursor-not-allowed rounded-lg border border-border px-4 py-2 text-sm font-semibold opacity-50"
          >
            Approve in wallet
          </button>
        )}
      </div>
    </section>
  );
}
