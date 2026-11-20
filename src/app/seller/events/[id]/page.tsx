import Link from "next/link";
import { notFound } from "next/navigation";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { isEventOwner } from "@/lib/auth/permissions";
import { getEventView } from "@/features/events/event-store";
import { formatEventDate } from "@/features/events/event-formatting";
import { TierManager } from "@/features/events/tier-manager";
import { PublishPanel } from "@/features/events/publish-panel";
import { EventDetailsForm } from "@/features/events/event-details-form";

export const metadata = { title: "Event setup" };

/**
 * XRPL-016 — ticket tiers, prices and quantities for one event.
 *
 * Draft/edit/publish controls are added by XRPL-017.
 */
export default async function SellerEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getCurrentSession();
  const canManage =
    !!session &&
    !!session.onboardedAt &&
    (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canManage) {
    return (
      <>
        <PageHeader title="Event setup" />
        <EmptyState
          title={session ? "Your account can't manage events" : "Sign in to manage events"}
          description="Event management is available to seller and organiser accounts."
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

  const db = getDb();
  /*
   * A non-owner gets the same 404 as a missing event, so this page cannot be
   * used to discover that another seller's draft exists.
   */
  if (!(await isEventOwner(db, session.userId, id))) notFound();

  const event = await getEventView(db, id);
  if (!event) notFound();

  return (
    <>
      <PageHeader
        title={event.title}
        description={`${formatEventDate(event.startsAt)} · ${event.venue}, ${event.city}`}
        actions={
          <Link
            href="/seller/events"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            All events
          </Link>
        }
      />

      <div className="flex flex-col gap-8">
        <PublishPanel event={event} />
        <TierManager event={event} />
        <EventDetailsForm event={event} />
      </div>

      <p className="mt-8 text-sm text-muted">
        Setting a price and quantity reserves nothing on the ledger. Tickets become NFTs
        only when they are minted, which is a separate, wallet-approved step.
      </p>
    </>
  );
}
