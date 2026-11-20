import Link from "next/link";
import type { DemoPersona } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentSession } from "@/lib/auth/current-session";
import { listDemoPersonas } from "@/lib/auth/onboarding";
import { getDb } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";
import { DemoPersonaList } from "@/features/onboarding/demo-persona-list";
import { OnboardingForm } from "@/features/onboarding/onboarding-form";
import { ROLE_HOME, ROLE_LABEL } from "@/features/onboarding/roles";
import { SignOutButton } from "@/features/onboarding/sign-out-button";

export const metadata = { title: "Get started" };

/**
 * XRPL-010 onboarding. Signed out: choose a role or continue as a demo persona.
 * Signed in: account summary, sign out and (demo only) persona switching.
 */
export default async function OnboardingPage() {
  const session = await getCurrentSession();
  const demoEnabled = getServerEnv().DEMO_LOGIN_ENABLED;
  const personas: DemoPersona[] = demoEnabled
    ? await listDemoPersonas(getDb()).catch((err: unknown) => {
        console.error("[onboarding] could not load demo personas", err);
        return [];
      })
    : [];

  const demoSection = demoEnabled ? (
    <section aria-labelledby="demo-heading" className="mt-10">
      <h2 id="demo-heading" className="text-lg font-semibold">
        Use a demo account
      </h2>
      <p className="mt-1 mb-4 max-w-2xl text-sm text-muted">
        Sample accounts for trying the platform. They&apos;re labelled as demo content and hold no real value.
      </p>
      <DemoPersonaList personas={personas} currentUserId={session?.userId ?? null} />
    </section>
  ) : null;

  if (session?.onboardedAt) {
    return (
      <>
        <PageHeader title="Your account" description="You're signed in. Your role decides which tools you see." />
        <section className="rounded-card border border-border bg-surface-raised p-5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-base font-semibold">{session.displayName}</p>
            <Badge tone={session.role === "CUSTOMER" ? "neutral" : "accent"}>{ROLE_LABEL[session.role]}</Badge>
            {session.isDemo ? <Badge tone="caution">Demo account</Badge> : null}
          </div>
          <p className="mt-3 text-sm text-muted">
            {session.walletAddress ? (
              <>
                Verified wallet: <span className="font-mono">{session.walletAddress}</span>
              </>
            ) : (
              "No wallet linked yet. You'll approve every transaction in your own wallet once wallet sign-in is available."
            )}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href={ROLE_HOME[session.role]}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
            >
              Continue
            </Link>
            <SignOutButton />
          </div>
        </section>
        {demoSection}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={session ? "Finish setting up" : "Get started"}
        description="Pick how you'll use XRPL Tickets. You approve every transaction in your own wallet. This platform never asks for a seed phrase or private key."
      />
      <section className="rounded-card border border-border bg-surface p-5">
        <OnboardingForm finishingExistingAccount={Boolean(session)} />
      </section>
      {demoSection}
    </>
  );
}
