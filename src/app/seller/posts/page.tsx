import Link from "next/link";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import type { SellerPostsDashboard } from "@/contracts/community";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getSellerPostsDashboard } from "@/features/community/posts";
import { SellerPostsManager } from "@/features/community/seller-posts-manager";

export const metadata = { title: "Your posts" };

/**
 * XRPL-080 / XRPL-081: a seller writes, edits and deletes posts and sees their engagement.
 *
 * Hiding this page from customers is a convenience only. The API it posts to checks the role on
 * every request.
 */
export default async function SellerPostsPage() {
  const session = await getCurrentSession();
  const canPost =
    !!session && !!session.onboardedAt && (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canPost) {
    return (
      <>
        <PageHeader title="Your posts" />
        <EmptyState
          title={session ? "Only sellers and organisers can post" : "Sign in to post"}
          description="Posts appear on a seller's public page. Customers can like and comment on them."
          action={
            <Link
              href={session ? "/" : "/onboarding"}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              {session ? "Browse events" : "Get started"}
            </Link>
          }
        />
      </>
    );
  }

  let dashboard: SellerPostsDashboard;
  try {
    dashboard = await getSellerPostsDashboard(getDb(), session.userId);
  } catch (error) {
    console.error("[community] could not load the seller's posts", error);
    return (
      <>
        <PageHeader title="Your posts" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your posts could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Your posts"
        description="Announcements for the people who follow you. They appear on your public page."
        actions={
          <Link
            href={`/sellers/${session.userId}`}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            View public page
          </Link>
        }
      />
      <SellerPostsManager initial={dashboard} />
    </>
  );
}
