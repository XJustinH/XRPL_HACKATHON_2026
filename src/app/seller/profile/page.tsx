import Link from "next/link";
import { EVENT_MANAGER_ROLES } from "@/contracts";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getSellerProfile } from "@/features/profiles/profile-store";
import { SellerProfileForm } from "@/features/profiles/seller-profile-form";

export const metadata = { title: "Your storefront" };

/**
 * XRPL-055 — a seller edits their own storefront.
 *
 * The route reads the session's own profile and the API it posts to cannot name
 * another account, so there is no path here to editing someone else's profile.
 */
export default async function SellerProfilePage() {
  const session = await getCurrentSession();
  const canManage =
    !!session &&
    !!session.onboardedAt &&
    (EVENT_MANAGER_ROLES as readonly string[]).includes(session.role);

  if (!canManage) {
    return (
      <>
        <PageHeader title="Your storefront" />
        <EmptyState
          title={session ? "Your account has no storefront" : "Sign in to edit your storefront"}
          description="Storefronts belong to seller and organiser accounts."
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

  let profile;
  try {
    profile = await getSellerProfile(getDb(), session.userId);
  } catch (error) {
    console.error("[profiles] could not load the seller's own profile", error);
    return (
      <>
        <PageHeader title="Your storefront" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your profile could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Your storefront"
        description="How you appear to buyers browsing your events."
        actions={
          <Link
            href={`/sellers/${session.userId}`}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            View public page
          </Link>
        }
      />
      <SellerProfileForm profile={profile} />
    </>
  );
}
