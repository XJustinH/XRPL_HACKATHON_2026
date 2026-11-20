import { notFound } from "next/navigation";
import { z } from "zod";
import { PageHeader } from "@/components/ui/page-header";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { CheckInTimeline } from "@/features/organiser/checkin-timeline";
import { OrganiserEventTabs } from "@/features/organiser/event-tabs";
import { MetricTiles } from "@/features/organiser/metric-tiles";
import { getEventMetrics } from "@/features/organiser/metrics";
import { NotYourEvent, SignInToManage } from "@/features/organiser/organiser-page-guard";
import { RefreshButton } from "@/features/organiser/refresh-button";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";

export const metadata = { title: "Event analytics" };

/** Seller analytics (XRPL-077): sales, resale and entry figures from validated records. */
export default async function AnalyticsPage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) notFound();
  const eventId = parsed.data;

  const session = await getCurrentSession();
  if (!session) return <SignInToManage title="Event analytics" />;

  const db = getDb();
  const event = await db.event.findUnique({ where: { id: eventId }, select: { title: true } });
  if (!event) notFound();
  if (!(await new EventSellerAccess(db).canScanEvent(session.userId, eventId))) {
    return <NotYourEvent title="Event analytics" />;
  }

  const metrics = await getEventMetrics(db, eventId);
  return (
    <>
      <PageHeader title={`Analytics: ${event.title}`} actions={<RefreshButton />} />
      <OrganiserEventTabs eventId={eventId} current="analytics" />

      <MetricTiles metrics={metrics} />

      <section aria-labelledby="entry-rate-heading" className="mt-8 rounded-card border border-border bg-surface-raised p-5">
        <h2 id="entry-rate-heading" className="text-lg font-semibold">
          Check-ins over time
        </h2>
        <p className="mb-4 text-sm text-muted">How quickly people came through the door.</p>
        <CheckInTimeline metrics={metrics} />
      </section>

      <p className="mt-6 text-sm text-muted">
        Only activity validated on the XRP Ledger is counted: sales and resales once the purchase transaction is
        validated, check-ins once admitted at the door. Resales and transfers made outside this app are not included.
        Updated {new Date(metrics.calculatedAt).toUTCString()}.
      </p>
    </>
  );
}
