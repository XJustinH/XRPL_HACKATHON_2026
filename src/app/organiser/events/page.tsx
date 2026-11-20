import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SignInToManage } from "@/features/organiser/organiser-page-guard";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "My events" };

/**
 * Entry point to the organiser tools (inventory XRPL-021, check-in XRPL-048) for the signed-in
 * seller's events. Creating and editing events is Agent C's seller area (XRPL-015..017).
 */
export default async function OrganiserEventsPage() {
  const session = await getCurrentSession();
  if (!session) return <SignInToManage title="My events" />;

  const events = await getDb().event.findMany({
    where: { sellerId: session.userId },
    orderBy: { startsAt: "asc" },
    select: { id: true, title: true, startsAt: true, venue: true, city: true, status: true },
  });

  return (
    <>
      <PageHeader title="My events" description="Ticket inventory and door check-in for events you organise." />
      {events.length === 0 ? (
        <EmptyState title="No events yet" description="Events you create as a seller appear here." />
      ) : (
        <ul className="grid gap-3">
          {events.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-3 rounded-card border border-border bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-semibold">
                  {e.title} {e.status === "DRAFT" ? <Badge tone="neutral">Draft</Badge> : null}
                </p>
                <p className="text-sm text-muted">
                  {e.venue}, {e.city} · {e.startsAt.toUTCString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Link
                  href={`/organiser/events/${e.id}/inventory`}
                  className="min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
                >
                  Inventory
                </Link>
                <Link
                  href={`/organiser/events/${e.id}/checkin`}
                  className="min-h-11 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
                >
                  Check-in
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
