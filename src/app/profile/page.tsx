import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { EmptyState, NotImplementedNotice } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { ROLE_LABEL } from "@/features/onboarding/roles";
import { SignOutButton } from "@/features/onboarding/sign-out-button";

export const metadata = { title: "Profile" };

/**
 * Account summary and the signed-in user's account actions.
 *
 * The profile itself (display name, city, interests, activity) arrives with
 * XRPL-056. This page exists now so that signing out is reachable from the
 * account area rather than only from the onboarding screen.
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

  return (
    <>
      <PageHeader
        title="Your profile"
        description="Your display name, chosen city and interests. Profile visibility is yours to control."
      />

      <section
        aria-labelledby="account-heading"
        className="rounded-card border border-border bg-surface-raised p-5"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="account-heading" className="text-lg font-semibold">
            {session.displayName}
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

      <div className="mt-6">
        <NotImplementedNotice
          title="Profile details and activity summary"
          blockedBy="XRPL-056, which builds the editable profile, chosen city and interests on top of this account summary"
        />
      </div>
    </>
  );
}
