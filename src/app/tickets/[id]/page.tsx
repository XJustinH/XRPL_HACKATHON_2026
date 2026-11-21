import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatEventDate, isPastEvent } from "@/features/events/event-formatting";
import { shortAddress } from "@/features/transfers/api";
import { getOpenOffer } from "@/features/transfers/server";
import { TicketTransferPanel } from "@/features/transfers/ticket-transfer-panel";
import { card } from "@/features/wallet/styles";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getTicketView } from "@/lib/xrpl/tickets/ownership";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

export const metadata = { title: "Ticket" };

/**
 * One ticket with its ledger proof (XRPL-034), and the holder's actions: check in (XRPL-044) or pass
 * it on by resale, private sale or gift (XRPL-036/040/041).
 *
 * Ownership is read from a validated ledger on every load, never from the app's cache, so a ticket
 * that moved elsewhere shows its real owner. Only the wallet holding it sees the actions.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) notFound();

  const session = await getCurrentSession();
  const viewer = session?.walletAddress ?? null;
  const deps = mintingDeps();

  let view: Awaited<ReturnType<typeof getTicketView>>;
  try {
    view = await getTicketView(deps, { ticketId: id.data, viewerAddress: viewer });
  } catch (error) {
    if ((error as { status?: number }).status === 404) notFound();
    console.error("[tickets] could not read ticket ownership", error);
    return (
      <>
        <PageHeader title="Ticket" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-6 text-center text-sm text-critical">
          The XRP Ledger could not be reached, so this ticket&apos;s owner can&apos;t be confirmed right now. This
          doesn&apos;t affect the ticket. Refresh to try again.
        </p>
      </>
    );
  }

  const ticket = view.ticket;
  if (!ticket) {
    return (
      <>
        <PageHeader title="Ticket" />
        <EmptyState
          title="This ticket's owner can't be confirmed right now"
          description={
            view.ownership.detail ??
            "Its NFT may still be minting, or the XRP Ledger couldn't be read. Check back shortly."
          }
        />
      </>
    );
  }

  const checkedIn = ticket.checkedInAt !== null;
  const past = isPastEvent(ticket.event.startsAt);
  const canAct = ticket.ownedByViewer && !checkedIn && !past && viewer !== null;
  const openOffer = canAct ? await getOpenOffer(deps.db, ticket.id, viewer) : null;
  const { ledger } = ticket;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <PageHeader
        title={ticket.event.title}
        description={`${formatEventDate(ticket.event.startsAt)} · ${ticket.event.venue}, ${ticket.event.city}`}
      />

      <section aria-labelledby="ticket-heading" className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="ticket-heading" className="text-lg font-semibold">
            {ticket.tierName} · #{ticket.serial}
          </h2>
          {checkedIn ? (
            <Badge tone="positive">Checked in</Badge>
          ) : past ? (
            <Badge tone="neutral">Not used</Badge>
          ) : (
            <Badge tone="accent">Valid</Badge>
          )}
        </div>

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">Owner</dt>
          <dd>
            <span className="font-mono">{shortAddress(ledger.ownerAddress)}</span>
            {ticket.ownedByViewer ? " (your wallet)" : null}
          </dd>
          <dt className="text-muted">Ticket NFT</dt>
          <dd>
            <a href={ledger.explorerNftUrl} target="_blank" rel="noopener noreferrer" className="font-mono underline">
              {ledger.nftokenId.slice(0, 8)}…{ledger.nftokenId.slice(-8)}
            </a>
          </dd>
          <dt className="text-muted">Minted by</dt>
          <dd>
            <span className="font-mono">{shortAddress(ledger.issuerAddress)}</span>{" "}
            <a href={ledger.explorerTxUrl} target="_blank" rel="noopener noreferrer" className="underline">
              mint transaction
            </a>
          </dd>
          <dt className="text-muted">Checked on the ledger</dt>
          <dd>
            Ledger {ledger.ledgerIndex.toLocaleString("en")}, {formatEventDate(ledger.verifiedAt)}
          </dd>
        </dl>
        <p className="mt-4 text-sm text-muted">
          This ticket is an NFT on the XRP Ledger Testnet. Its owner is read from the ledger itself, so anyone can
          check it with the links above.
        </p>
      </section>

      {canAct ? (
        <>
          <Link
            href={`/checkin/${ticket.id}`}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Show check-in code
          </Link>
          <TicketTransferPanel ticketId={ticket.id} holderAddress={viewer} openOffer={openOffer} />
        </>
      ) : ticket.ownedByViewer ? null : (
        <p className="text-sm text-muted">
          {session ? "Your connected wallet doesn't hold this ticket." : "Sign in with the wallet that holds this ticket to use it."}
        </p>
      )}
    </div>
  );
}
