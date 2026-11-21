import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatEventDate } from "@/features/events/event-formatting";
import { AcceptOffer } from "@/features/transfers/accept-offer";
import { shortAddress } from "@/features/transfers/api";
import { getOfferPage } from "@/features/transfers/server";
import { card, notice } from "@/features/wallet/styles";
import { getCurrentSession } from "@/lib/auth/current-session";
import { formatDropsAsXrp } from "@/lib/xrpl/format";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

export const metadata = { title: "Ticket offer" };

/**
 * One holder offer (XRPL-039/040/041): a resale listing anyone can buy while the in-app resale rule
 * lists it, or a private sale or gift that only the named wallet can see and accept. The holder
 * shares this page's link with their friend.
 */
export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const session = await getCurrentSession();
  const viewer = session?.walletAddress ?? null;
  const page = await getOfferPage(mintingDeps(), id.data, viewer);
  if (page.status === "NOT_FOUND") notFound();

  if (page.status === "NOT_FOR_YOU") {
    return (
      <>
        <PageHeader title="Ticket offer" />
        <EmptyState
          title={viewer ? "This offer is for a different wallet" : "Sign in to see this offer"}
          description={
            viewer
              ? "It can only be opened by the wallet it was sent to. Switch to that wallet and connect it."
              : "This ticket was offered to one wallet. Sign in and connect that wallet to see and accept it."
          }
          action={
            <Link
              href={viewer ? "/connect" : "/onboarding"}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              {viewer ? "Connect a different wallet" : "Get started"}
            </Link>
          }
        />
      </>
    );
  }

  const { offer } = page;
  const isGift = offer.kind === "GIFT";
  const title = isGift ? "A ticket gift for you" : offer.kind === "PRIVATE" ? "A ticket offered to you" : "Resale ticket";
  const own = viewer === offer.sellerAddress;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <PageHeader title={title} />
      <section aria-labelledby="offer-heading" className={card}>
        <h2 id="offer-heading" className="text-lg font-semibold">
          {offer.event.title}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {formatEventDate(offer.event.startsAt)} · {offer.event.venue}, {offer.event.city}
        </p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-muted">Ticket</dt>
          <dd>
            {offer.ticket.tierName} · #{offer.ticket.serial}
          </dd>
          <dt className="text-muted">Price</dt>
          <dd>
            {isGift ? "Free (gift)" : `${formatDropsAsXrp(offer.amountDrops)} XRP`}
            {!isGift ? (
              <span className="text-muted"> · face value {formatDropsAsXrp(offer.ticket.faceValueDrops)} XRP</span>
            ) : null}
          </dd>
          <dt className="text-muted">From</dt>
          <dd className="font-mono">{shortAddress(offer.sellerAddress)}</dd>
        </dl>
        {offer.kind === "RESALE" ? <p className="mt-4 text-sm text-muted">{RESALE_LIMITATION_NOTICE}</p> : null}
      </section>

      {page.status === "CLOSED" ? (
        <p role="status" className={notice.caution}>
          {offer.state === "ACCEPTED"
            ? "This offer has been accepted, so the ticket has moved."
            : offer.state === "CANCELLED"
              ? "This offer was cancelled by the person who made it."
              : offer.used
              ? "This ticket has already been used to enter the event, so it can't change hands."
              : "This offer is no longer open."}
        </p>
      ) : own ? (
        <p className="text-sm text-muted">
          This is your own offer. Share this page&apos;s link with the person it&apos;s for, or{" "}
          <Link href={`/tickets/${offer.ticket.id}`} className="font-medium text-accent underline">
            cancel it from your ticket
          </Link>
          .
        </p>
      ) : !viewer ? (
        <p className={notice.caution}>
          Connect your Xaman wallet to {isGift ? "accept this gift" : "buy this ticket"}.{" "}
          <Link href="/connect" className="font-semibold underline">
            Connect wallet
          </Link>
        </p>
      ) : (
        <AcceptOffer
          offerId={offer.id}
          kind={offer.kind}
          amountDrops={offer.amountDrops}
          // A buyer who loses a resale ticket to someone else is shown the event's other listings (XRPL-035).
          otherTicketsHref={offer.kind === "RESALE" ? `/resale?eventId=${offer.event.id}` : undefined}
        />
      )}
    </div>
  );
}
