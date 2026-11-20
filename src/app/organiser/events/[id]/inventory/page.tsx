import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { OrganiserEventTabs } from "@/features/organiser/event-tabs";
import { getEventInventory } from "@/features/organiser/inventory";
import { InventoryTable } from "@/features/organiser/inventory-table";
import { NotYourEvent, SignInToManage } from "@/features/organiser/organiser-page-guard";
import { RefreshButton } from "@/features/organiser/refresh-button";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Ticket inventory" };

/**
 * Seller ticket inventory (XRPL-021): per tier, total / minted / on sale / sold / unsold.
 * Rendered on the server from validated records on every request.
 */
export default async function InventoryPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const eventId = parsed.data;

  const session = await getCurrentSession();
  if (!session) return <SignInToManage title="Ticket inventory" />;

  const db = getDb();
  const event = await db.event.findUnique({ where: { id: eventId }, select: { title: true, status: true } });
  if (!event) notFound();
  if (!(await new EventSellerAccess(db).canScanEvent(session.userId, eventId))) {
    return <NotYourEvent title="Ticket inventory" />;
  }

  const inventory = await getEventInventory(db, eventId);
  const { totals } = inventory;
  return (
    <>
      <PageHeader title={`Inventory: ${event.title}`} actions={<RefreshButton />} />
      <OrganiserEventTabs eventId={eventId} current="inventory" />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {event.status === "DRAFT" ? <Badge tone="neutral">Draft</Badge> : <Badge tone="accent">Published</Badge>}
        {inventory.primarySoldOut ? <Badge tone="positive">Primary sold out</Badge> : null}
        <span className="text-sm text-muted">
          {totals.sold} of {totals.total} sold · {inventory.checkedIn} checked in
        </span>
      </div>

      <InventoryTable inventory={inventory} />

      <div className="mt-6 space-y-2 text-sm text-muted">
        <p>
          Minted and sold only count once the transaction is validated on the XRP Ledger, so they can lag a purchase by
          a few seconds. Updated {new Date(inventory.calculatedAt).toUTCString()}.
        </p>
        <p>
          {inventory.primarySoldOut
            ? "Resale is open in this app."
            : "Resale opens in this app once every primary ticket has sold."}{" "}
          Ticket NFTs are transferable, so holders can still sell or transfer them directly on the XRP Ledger outside
          this app.
        </p>
      </div>
    </>
  );
}
