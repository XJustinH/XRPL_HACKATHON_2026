import type { ReportView } from "@/contracts/community";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { isModerator, isSellerRole } from "@/features/community/access";
import { ModerationQueue } from "@/features/community/moderation-queue";
import { listOpenReports } from "@/features/community/reports";

export const metadata = { title: "Moderation" };

/**
 * XRPL-083: the report queue.
 *
 * Site moderators (MODERATOR_USER_IDS) see every open report. A seller sees only reports about
 * other people's comments on their posts and reviews of their events. Customers who are not
 * moderators have nothing to do here. The list and both actions are checked again by the API.
 */
export default async function ModerationPage() {
  const session = await getCurrentSession();
  const moderator = isModerator(session?.userId);

  if (!session || (!moderator && !isSellerRole(session.role))) {
    return (
      <>
        <PageHeader title="Moderation" />
        <EmptyState
          title="This page is for moderators"
          description="To flag something, use the Report control next to a review, comment or post."
        />
      </>
    );
  }

  let reports: ReportView[];
  try {
    reports = await listOpenReports(getDb(), session.userId);
  } catch (error) {
    console.error("[community] could not load the report queue", error);
    return (
      <>
        <PageHeader title="Moderation" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Reports could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Moderation"
        description={
          moderator
            ? "Open reports across the site. Hiding keeps the content on record but removes it from public view."
            : "Open reports about comments on your posts and reviews of your events."
        }
      />
      <ModerationQueue initial={reports} />
    </>
  );
}
