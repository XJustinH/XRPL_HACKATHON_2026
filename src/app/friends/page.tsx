import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { FriendsPanel } from "@/features/friends/friends-panel";
import { getCurrentSession } from "@/lib/auth/current-session";

export const metadata = { title: "Friends" };

/** Friend connections (XRPL-084). Opt-in: people connect by sharing a friend code. */
export default async function FriendsPage() {
  const session = await getCurrentSession();
  if (!session) {
    return (
      <>
        <PageHeader title="Friends" />
        <EmptyState
          title="Sign in to see your friends"
          description="Connect with friends to see which events they're going to, if they choose to share."
          action={
            <Link href="/onboarding" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90">
              Sign in
            </Link>
          }
        />
      </>
    );
  }
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Friends" description="Connect by sharing your friend code. Your friend list is private unless you choose otherwise." />
      <FriendsPanel />
    </div>
  );
}
