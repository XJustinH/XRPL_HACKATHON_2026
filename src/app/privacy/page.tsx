import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getVisibilitySettings } from "@/features/privacy/friend-activity";
import { VisibilityForm } from "@/features/privacy/visibility-form";

export const metadata = { title: "Privacy" };

/** XRPL-088 — what a customer shares with friends. Private by default. */
export default async function PrivacyPage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Privacy" />
        <EmptyState
          title="Sign in to manage your privacy"
          description="Your attendance and saved events are private until you choose otherwise."
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

  let settings;
  try {
    settings = await getVisibilitySettings(getDb(), session.userId);
  } catch (error) {
    console.error("[privacy] could not load visibility settings", error);
    return (
      <>
        <PageHeader title="Privacy" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your privacy settings could not be loaded. Nothing has been changed — refresh to
          try again.
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Privacy"
        description="You decide what your friends can see. Nothing here is ever public."
        actions={
          <Link
            href="/profile"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            Back to profile
          </Link>
        }
      />
      <VisibilityForm settings={settings} />
    </>
  );
}
