import Link from "next/link";
import { connection } from "next/server";
import type { TicketView } from "@/contracts";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { listTicketsForOwner } from "@/lib/xrpl/tickets/ownership";
import { mintingDeps } from "@/lib/xrpl/tickets/server";
import { TicketCard } from "@/features/tickets/ticket-card";

export const metadata = { title: "My tickets" };

/**
 * XRPL-033 — tickets currently held by the signed-in wallet.
 *
 * The list is built from the wallet's NFTs on a validated ledger, not from the
 * application's cached owner, so a ticket transferred away elsewhere stops
 * appearing here as soon as the page is reloaded. That read also refreshes the
 * cache and marks tickets the wallet no longer holds as stale.
 */
export default async function MyTicketsPage() {
  // Ownership is live ledger state; never served from a cache.
  await connection();

  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="My tickets" />
        <EmptyState
          title="Sign in to see your tickets"
          description="Your tickets live in your wallet. Sign in and connect it to see them here."
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

  if (!session.walletAddress) {
    return (
      <>
        <PageHeader title="My tickets" />
        <EmptyState
          title="Connect your wallet"
          description="Tickets are NFTs held by your wallet. Prove control of it to see the tickets it holds."
          action={
            <Link
              href="/connect"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Connect your wallet
            </Link>
          }
        />
      </>
    );
  }

  let tickets: TicketView[] | null = null;
  try {
    tickets = await listTicketsForOwner(mintingDeps(), {
      address: session.walletAddress,
      viewerAddress: session.walletAddress,
    });
  } catch (error) {
    /*
     * A ledger failure must not be rendered as "you own nothing" — that would
     * read as tickets having disappeared.
     */
    console.error("[tickets] could not read wallet holdings", error);
  }

  if (tickets === null) {
    return (
      <>
        <PageHeader title="My tickets" />
        <div
          role="alert"
          className="rounded-card border border-border bg-critical-soft px-5 py-6 text-center text-sm text-critical"
        >
          <p className="font-semibold">Your tickets could not be read</p>
          <p className="mt-1">
            The XRP Ledger could not be reached, so we cannot confirm what your wallet
            holds. This does not affect your tickets — refresh to try again.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="My tickets"
        description="Tickets held by your connected wallet, confirmed against the XRP Ledger."
      />

      {tickets.length === 0 ? (
        <EmptyState
          title="No tickets in this wallet"
          description="Tickets you buy appear here automatically. If you expected one, check that the wallet you connected is the one that holds it."
          action={
            <Link
              href="/"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Find an event
            </Link>
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <TicketCard ticket={ticket} />
              </li>
            ))}
          </ul>

          <p className="mt-8 text-sm text-muted">
            Showing {tickets.length} {tickets.length === 1 ? "ticket" : "tickets"} held by{" "}
            <span className="font-mono text-xs">{session.walletAddress}</span>. Ownership
            is read from the ledger each time this page loads, so a ticket you transfer
            away stops appearing here.
          </p>
        </>
      )}
    </>
  );
}
