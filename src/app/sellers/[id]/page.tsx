import Link from "next/link";
import { ArtworkPlaceholder } from "@/components/ui/artwork-placeholder";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { safeExternalUrl, type SellerProfile } from "@/contracts";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getDb } from "@/lib/db/client";
import { SellerCollectiblesSection } from "@/features/collectibles/sections";
import { EventCard } from "@/features/events/event-card";
import { SellerMerchSection } from "@/features/commerce/seller-merch-section";
import { SellerPostsFeed } from "@/features/community/seller-posts-feed";
import { organiserBrowseHref } from "@/features/discovery/browse-links";
import { isFollowing } from "@/features/profiles/follows";
import { FollowButton } from "@/features/profiles/follow-button";
import {
  getSellerProfile,
  listSellerStorefrontEvents,
  ProfileNotFoundError,
} from "@/features/profiles/profile-store";

/**
 * Public seller storefront (XRPL-055).
 *
 * One landing page for an artist, venue or organiser: who they are, what they
 * have coming up, and where their merchandise will live.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const profile = await getSellerProfile(getDb(), id).catch(() => null);
  return { title: profile?.displayName ?? "Seller" };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ProfileHeader({ profile }: { profile: SellerProfile }) {
  /*
   * Stored values are re-checked before rendering. Validation on write is the
   * main defence, but a row written before that rule existed must not put a
   * `javascript:` URL into an href on a public page.
   */
  const imageUrl = safeExternalUrl(profile.imageUrl);
  const websiteUrl = safeExternalUrl(profile.websiteUrl);
  const socialLinks = profile.socialLinks
    .map((link) => ({ label: link.label, url: safeExternalUrl(link.url) }))
    .filter((link): link is { label: string; url: string } => link.url !== null);

  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="size-20 shrink-0 overflow-hidden rounded-full bg-surface">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary seller-supplied host
          <img src={imageUrl} alt="" className="size-full object-cover" />
        ) : (
          <ArtworkPlaceholder name={profile.displayName} className="text-3xl!" />
        )}
      </div>

      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {profile.displayName}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {profile.city ? `${profile.city} · ` : null}
          {profile.publishedEventCount}{" "}
          {profile.publishedEventCount === 1 ? "published event" : "published events"}
        </p>
        {profile.bio ? (
          <p className="mt-3 max-w-2xl whitespace-pre-line text-sm">{profile.bio}</p>
        ) : null}

        {websiteUrl || socialLinks.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {websiteUrl ? (
              <li>
                <a
                  href={websiteUrl}
                  target="_blank"
                  rel="noreferrer noopener nofollow ugc"
                  className="text-accent underline"
                >
                  {hostOf(websiteUrl)}
                </a>
              </li>
            ) : null}
            {socialLinks.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  /* nofollow/ugc: these are user-submitted links. */
                  rel="noreferrer noopener nofollow ugc"
                  className="text-accent underline"
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </header>
  );
}

export default async function SellerStorefrontPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  let profile: SellerProfile;
  try {
    profile = await getSellerProfile(db, id);
  } catch (error) {
    if (error instanceof ProfileNotFoundError) notFound();
    throw error;
  }

  const [events, session] = await Promise.all([
    listSellerStorefrontEvents(db, id),
    getCurrentSession(),
  ]);
  const isOwnProfile = session?.userId === id;
  // Only meaningful for a signed-in visitor who is not the seller themselves.
  const following =
    session && !isOwnProfile ? await isFollowing(db, session.userId, id).catch(() => false) : false;

  return (
    <>
      <ProfileHeader profile={profile} />

      <div className="mt-4">
        {isOwnProfile ? (
          <Link
            href="/seller/profile"
            className="inline-block rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface"
          >
            Edit your profile
          </Link>
        ) : session ? (
          <FollowButton
            sellerId={profile.id}
            initialFollowing={following}
            sellerName={profile.displayName}
          />
        ) : (
          <p className="text-sm text-muted">
            <Link href="/onboarding" className="font-medium text-accent underline">
              Sign in
            </Link>{" "}
            to follow {profile.displayName} and see their new events.
          </p>
        )}
      </div>

      <section aria-labelledby="events-heading" className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="events-heading" className="text-lg font-semibold">
            Upcoming events
          </h2>
          {events.length > 0 ? (
            <Link
              href={organiserBrowseHref(profile.id)}
              className="text-sm font-medium text-accent underline"
            >
              Search within this organiser
            </Link>
          ) : null}
        </div>
        {events.length === 0 ? (
          <p className="mt-4 rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
            No upcoming events on sale right now.
          </p>
        ) : (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => (
              <li key={event.id}>
                <EventCard event={event} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Announcements and posts, with likes and comments (XRPL-080 to XRPL-082). */}
      <div className="mt-10">
        <SellerPostsFeed sellerId={id} viewer={session} />
      </div>

      {/* Published physical merchandise (XRPL-065/066). Renders its own "Merchandise" section. */}
      <SellerMerchSection sellerId={profile.id} />

      {/* Published digital collectibles (XRPL-072). Renders nothing when the seller has none. */}
      <SellerCollectiblesSection sellerId={profile.id} />
    </>
  );
}
