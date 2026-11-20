import Link from "next/link";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { EventForm } from "@/features/events/event-form";

export const metadata = { title: "Create event" };

/**
 * XRPL-015 — seller event creation.
 *
 * The role check here only decides what to render. `POST /api/events` performs
 * the authoritative check with `requireEventManager`, so reaching this page
 * another way still cannot create an event.
 */
export default async function NewEventPage() {
  const session = await getCurrentSession();
  const canManage =
    !!session &&
    !!session.onboardedAt &&
    (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canManage) {
    return (
      <>
        <PageHeader title="Create an event" />
        <EmptyState
          title={session ? "Your account can't create events" : "Sign in to create an event"}
          description={
            session
              ? "Event creation is available to seller and organiser accounts."
              : "Create a seller profile, or use a demo seller account, to publish events."
          }
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

  return (
    <>
      <PageHeader
        title="Create an event"
        description="Enter the details that appear on the public event page and in each ticket's metadata."
        actions={
          <Link
            href="/seller/events"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            Cancel
          </Link>
        }
      />
      <EventForm />
    </>
  );
}
