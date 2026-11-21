import Link from "next/link";
import type { NotificationInbox } from "@/contracts/community";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getInbox } from "@/features/community/notifications";
import { NotificationsInbox } from "@/features/community/notifications-inbox";

export const metadata = { title: "Notifications" };

/**
 * XRPL-093: new events and posts from the accounts a user follows.
 *
 * Opening the page is what creates the notifications that are due, so there is no background job
 * and nothing is sent anywhere outside the app.
 */
export default async function NotificationsPage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Notifications" />
        <EmptyState
          title="Sign in to see your notifications"
          description="Follow an organiser and you will hear here when they announce an event."
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

  let inbox: NotificationInbox;
  try {
    inbox = await getInbox(getDb(), session.userId);
  } catch (error) {
    console.error("[community] could not load notifications", error);
    return (
      <>
        <PageHeader title="Notifications" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your notifications could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Notifications" description="New events and posts from the accounts you follow." />
      <NotificationsInbox initial={inbox} />
    </>
  );
}
