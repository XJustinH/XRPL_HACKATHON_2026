import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AppId } from "@/contracts/common";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { getPublicCustomerProfile } from "@/features/profiles/public-customer-profile";

export const metadata: Metadata = { title: "Profile" };

/**
 * A customer's profile as others see it (XRPL-087, with links from XRPL-091).
 *
 * Whether the detail is shown is decided in the store, which returns nothing
 * sensitive for a hidden profile — so this page cannot leak by rendering the
 * wrong field.
 */
export default async function CustomerProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!AppId.safeParse(id).success) notFound();

  const session = await getCurrentSession();
  const profile = await getPublicCustomerProfile(getDb(), {
    userId: id,
    viewerId: session?.userId ?? null,
  });
  if (!profile) notFound();

  return (
    <>
      <PageHeader
        title={profile.displayName}
        description={profile.visible && profile.city ? profile.city : undefined}
        actions={
          profile.isOwnProfile ? (
            <Link
              href="/profile"
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
            >
              Edit your profile
            </Link>
          ) : undefined
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {profile.isOwnProfile ? <Badge tone="accent">This is you</Badge> : null}
        {profile.isFriend ? <Badge tone="positive">Friend</Badge> : null}
      </div>

      {!profile.visible ? (
        <section className="rounded-card border border-border bg-surface px-5 py-6">
          <p className="text-sm font-medium">This profile is private</p>
          <p className="mt-1 text-sm text-muted">
            {profile.displayName} shares their profile with friends only.
            {session ? (
              <>
                {" "}
                <Link href="/friends" className="font-medium text-accent underline">
                  Send a friend request
                </Link>{" "}
                to see it.
              </>
            ) : (
              <>
                {" "}
                <Link href="/onboarding" className="font-medium text-accent underline">
                  Sign in
                </Link>{" "}
                if you are friends.
              </>
            )}
          </p>
        </section>
      ) : (
        <div className="flex flex-col gap-6">
          <section
            aria-labelledby="interests-heading"
            className="rounded-card border border-border bg-surface-raised p-5"
          >
            <h2 id="interests-heading" className="text-lg font-semibold">
              Interests
            </h2>
            {profile.interestLabels.length === 0 ? (
              <p className="mt-2 text-sm text-muted">None shared.</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {profile.interestLabels.map((label) => (
                  <li key={label}>
                    <Badge>{label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {profile.socialLinks.length > 0 ? (
            <section
              aria-labelledby="links-heading"
              className="rounded-card border border-border bg-surface-raised p-5"
            >
              <h2 id="links-heading" className="text-lg font-semibold">
                Links
              </h2>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {profile.socialLinks.map((link) => (
                  <li key={link.url}>
                    {/* nofollow/ugc: user-submitted. Schemes already filtered. */}
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener nofollow ugc"
                      className="text-accent underline"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="text-sm text-muted">
            Tickets, saved events and attendance are never shown on a profile. What
            friends can see is controlled in{" "}
            <Link href="/privacy" className="font-medium text-accent underline">
              privacy settings
            </Link>
            .
          </p>
        </div>
      )}
    </>
  );
}
