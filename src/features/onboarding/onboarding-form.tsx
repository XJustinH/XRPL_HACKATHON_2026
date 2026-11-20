"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { OnboardingRequest, type OnboardingResponse, type SelfServeRole } from "@/contracts";
import { postJson } from "./post-json";
import { ROLE_HOME } from "./roles";

const ROLE_OPTIONS: { value: SelfServeRole; title: string; description: string }[] = [
  {
    value: "CUSTOMER",
    title: "I'm here for events",
    description: "Find events, buy NFT tickets with your own wallet, and resell or gift them in the app.",
  },
  {
    value: "SELLER",
    title: "I run events",
    description: "Create events and ticket tiers, mint NFT tickets, and follow your sales.",
  },
];

export function OnboardingForm({ finishingExistingAccount = false }: { finishingExistingAccount?: boolean }) {
  const router = useRouter();
  const nameId = useId();
  const errorId = useId();
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<SelfServeRole>("CUSTOMER");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = OnboardingRequest.safeParse({ displayName, role });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check the form and try again.");
      return;
    }

    setSubmitting(true);
    const result = await postJson<OnboardingResponse>("/api/onboarding", parsed.data);
    if (!result.ok) {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    router.push(ROLE_HOME[parsed.data.role]);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-semibold">How will you use XRPL Tickets?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ROLE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer gap-3 rounded-card border border-border bg-surface-raised p-4 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
            >
              <input
                type="radio"
                name="role"
                value={option.value}
                checked={role === option.value}
                onChange={() => setRole(option.value)}
                className="mt-1 size-4 shrink-0 accent-accent"
              />
              <span>
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="mt-1 block text-sm text-muted">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">
          You choose a role once. Changing it later isn&apos;t self-service.
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className="text-sm font-semibold">
          Display name
        </label>
        <input
          id={nameId}
          name="displayName"
          type="text"
          autoComplete="nickname"
          required
          minLength={2}
          maxLength={80}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="w-full rounded-lg border border-border bg-canvas px-3 py-2.5 text-base sm:max-w-sm"
        />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
          {error}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60 sm:w-auto"
        >
          {submitting ? "Saving…" : finishingExistingAccount ? "Finish setting up" : "Create profile"}
        </button>
      </div>
    </form>
  );
}
