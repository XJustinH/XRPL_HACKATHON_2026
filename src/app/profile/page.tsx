import Link from "next/link";
import { EVENT_CATEGORY_LABELS } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { ROLE_LABEL } from "@/features/onboarding/roles";
import { SignOutButton } from "@/features/onboarding/sign-out-button";
import { getCustomerPreferences } from "@/features/profiles/customer-preferences";
import { getOwnCustomerProfile } from "@/features/profiles/customer-profile";
import { Avatar, CustomerProfileForm } from "@/features/profiles/customer-profile-form";
import { ActivitySummary, summariseUpcoming } from "@/features/profiles/activity-summary";
import { listAttendedEvents } from "@/features/checkin/attendance-history";
import { listTicketsForOwner } from "@/lib/xrpl/tickets/ownership";
import { mintingDeps } from "@/lib/xrpl/tickets/server";

export const metadata = { title: "Profile" };

/**
 * The signed-in user's profile: account summary and actions, editable display name and avatar,
 * discovery preferences (XRPL-058) and an activity summary (XRPL-056): upcoming events from the
 * tickets the wallet holds, events attended, followed sellers and wishlist.
 *
 * Each read below may fail on its own without taking the page down; a failure shows as
 * "couldn't load", never as "nothing here".
 */
export default async function ProfilePage() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <>
        <PageHeader title="Your profile" />
        <EmptyState
          title="You are not signed in"
          description="Sign in or create a profile to see your account, tickets and saved events."
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

  // Preferences are optional, so a read failure must not take the page down.
  const preferences = await getCustomerPreferences(getDb(), session.userId).catch(
    (error: unknown) => {
      console.error("[profiles] could not load preferences for the profile page", error);
      return { interests: [], city: null, hasPreferences: false } as const;
    },
  );

  const db = getDb();
  const [profile, upcoming, attended] = await Promise.all([
    getOwnCustomerProfile(db, session.userId).catch((error: unknown) => {
      console.error("[profiles] could not load the profile", error);
      return { displayName: session.displayName, imageUrl: null };
    }),
    session.walletAddress
      ? listTicketsForOwner(mintingDeps(), { address: session.walletAddress, viewerAddress: session.walletAddress })
          .then((tickets) => summariseUpcoming(tickets))
          .catch((error: unknown) => {
            console.error("[profiles] could not read wallet tickets", error);
            return null;
          })
      : Promise.resolve([]),
    listAttendedEvents(db, session.userId).catch((error: unknown) => {
      console.error("[profiles] could not load attended events", error);
      return null;
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Your profile"
        description="Your name and picture, your discovery preferences, and the events you're going to and have been to."
      />

      <section
        aria-labelledby="account-heading"
        className="rounded-card border border-border bg-surface-raised p-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <Avatar url={profile.imageUrl} name={profile.displayName} />
          <h2 id="account-heading" className="text-lg font-semibold">
            {profile.displayName}
          </h2>
          <Badge tone="accent">{ROLE_LABEL[session.role]}</Badge>
          {session.isDemo ? <Badge tone="caution">Demo account</Badge> : null}
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Wallet
            </dt>
            <dd className="mt-1 text-sm">
              {session.walletAddress ? (
                <span className="font-mono break-all">{session.walletAddress}</span>
              ) : (
                <span className="text-muted">
                  No wallet linked —{" "}
                  <Link href="/connect" className="font-medium text-accent underline">
                    connect one
                  </Link>
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">
              Wallet control
            </dt>
            <dd className="mt-1 text-sm">
              {session.walletAddress ? (
                "Proven for this session"
              ) : (
                <span className="text-muted">Not proven</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <SignOutButton />
          <Link
            href="/onboarding"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            Account settings
          </Link>
        </div>
      </section>

      <CustomerProfileForm profile={profile} />

      <section
        aria-labelledby="preferences-heading"
        className="mt-6 rounded-card border border-border bg-surface-raised p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="preferences-heading" className="text-lg font-semibold">
            Discovery preferences
          </h2>
          <Link
            href="/preferences"
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            {preferences.hasPreferences ? "Edit preferences" : "Set preferences"}
          </Link>
        </div>

        {preferences.hasPreferences ? (
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                Interests
              </dt>
              <dd className="mt-2 flex flex-wrap gap-2">
                {preferences.interests.length === 0 ? (
                  <span className="text-sm text-muted">None chosen</span>
                ) : (
                  preferences.interests.map((category) => (
                    <Badge key={category}>{EVENT_CATEGORY_LABELS[category]}</Badge>
                  ))
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                City or region
              </dt>
              <dd className="mt-2 text-sm">
                {preferences.city ?? <span className="text-muted">Not set</span>}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted">
            You have not set any. Events are not filtered or hidden because of this —
            preferences only change the order things appear in.
          </p>
        )}
      </section>

      <ActivitySummary hasWallet={!!session.walletAddress} upcoming={upcoming} attended={attended} />
    </>
  );
}
