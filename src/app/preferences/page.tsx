import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getCustomerPreferences } from "@/features/profiles/customer-preferences";
import { PreferencesForm } from "@/features/profiles/preferences-form";

export const metadata = { title: "Your preferences" };

/**
 * XRPL-058 — choose or change discovery preferences.
 *
 * Reachable as a step straight after onboarding (`?from=onboarding`, which adds
 * a Skip control) and as the editor from the profile page afterwards.
 */
export default async function PreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const [{ from }, session] = await Promise.all([searchParams, getCurrentSession()]);

  if (!session) {
    return (
      <>
        <PageHeader title="Your preferences" />
        <EmptyState
          title="Sign in to set preferences"
          description="Preferences are saved to your account. You can browse every event without them."
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

  let preferences;
  try {
    preferences = await getCustomerPreferences(getDb(), session.userId);
  } catch (error) {
    console.error("[profiles] could not load preferences", error);
    return (
      <>
        <PageHeader title="Your preferences" />
        <p role="alert" className="rounded-card bg-critical-soft px-5 py-4 text-sm text-critical">
          Your preferences could not be loaded. Refresh to try again.
        </p>
      </>
    );
  }

  const fromOnboarding = from === "onboarding";

  return (
    <>
      <PageHeader
        title={fromOnboarding ? "Tell us what you like" : "Your preferences"}
        description="Used to order what you see first. Nothing is hidden from you because of them."
        actions={
          fromOnboarding ? undefined : (
            <Link
              href="/profile"
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
            >
              Back to profile
            </Link>
          )
        }
      />
      <PreferencesForm
        preferences={preferences}
        showSkip={fromOnboarding}
        doneHref={fromOnboarding ? "/" : "/profile"}
      />
    </>
  );
}
