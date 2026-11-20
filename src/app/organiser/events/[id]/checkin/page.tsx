import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { GateScanner } from "@/features/checkin/gate-scanner";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { EntryOverview } from "@/features/organiser/entry-overview";
import { getCheckInOverview } from "@/features/organiser/checkin-overview";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Event check-in" };

/**
 * Organiser gate screen (XRPL-048): scan tickets, admit once, see who is in.
 * Access: the event's organiser (interim rule: its seller, until XRPL-013).
 */
export default async function EventCheckInPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const eventId = parsed.data;

  const session = await getCurrentSession();
  if (!session) {
    return (
      <>
        <PageHeader title="Event check-in" />
        <EmptyState
          title="Sign in to scan tickets"
          description="Only the event's organiser can check people in."
          action={
            <Link
              href="/onboarding"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Sign in
            </Link>
          }
        />
      </>
    );
  }

  const db = getDb();
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { title: true, startsAt: true, venue: true, city: true },
  });
  if (!event) notFound();

  if (!(await new EventSellerAccess(db).canScanEvent(session.userId, eventId))) {
    return (
      <>
        <PageHeader title="Event check-in" />
        <EmptyState
          title="You can't scan tickets for this event"
          description="Only the event's organiser can check people in."
        />
      </>
    );
  }

  const overview = await getCheckInOverview(db, eventId);
  return (
    <>
      <PageHeader
        title={`Check-in: ${event.title}`}
        description={`${event.venue}, ${event.city} · ${event.startsAt.toUTCString()}`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <GateScanner eventId={eventId} />
        <EntryOverview overview={overview} />
      </div>
    </>
  );
}
