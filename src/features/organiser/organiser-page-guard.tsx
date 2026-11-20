import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

/** Shared "sign in" and "not your event" states for organiser pages. */
export function SignInToManage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title="Sign in to manage your events"
        description="Only the event's organiser can see this."
        action={
          <Link
            href="/onboarding"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Sign in
          </Link>
        }
      />
    </>
  );
}

export function NotYourEvent({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="You don't organise this event" description="Only the event's organiser can see this." />
    </>
  );
}
