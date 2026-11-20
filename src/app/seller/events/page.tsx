import { PageHeader } from "@/components/ui/page-header";
import { NotImplementedNotice } from "@/components/ui/empty-state";
import { EVENT_MANAGER_ROLES } from "@/contracts/auth";
import type { UserRole } from "@/contracts/entities";
import { MintTicketsPanel } from "@/features/minting/mint-tickets-panel";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { listSellerEventsForMinting } from "@/lib/xrpl/tickets/minting";

export const metadata = { title: "Manage events" };

export default async function SellerEventsPage() {
  // Ticket minting (XRPL-024, Agent B) for the signed-in seller's own events. The mint routes
  // enforce ownership and the proven wallet themselves; this only decides what to show.
  const session = await getCurrentSession();
  const isEventManager = !!session && (EVENT_MANAGER_ROLES as readonly UserRole[]).includes(session.role);
  const mintableEvents = isEventManager ? await listSellerEventsForMinting(getDb(), session.userId) : null;

  return (
    <>
      <PageHeader
        title="Manage events"
        description="Create event drafts, define ticket tiers, and publish when the details are final."
      />
      <NotImplementedNotice
        title="Seller event management"
        blockedBy="XRPL-015 / XRPL-016 / XRPL-017, which need the event schema from XRPL-005 and role enforcement from XRPL-013"
      />
      {mintableEvents && session ? (
        <div className="mt-8">
          <MintTicketsPanel events={mintableEvents} issuerAddress={session.walletAddress} />
        </div>
      ) : null}
    </>
  );
}
