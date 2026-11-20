"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  type EventCategory,
} from "@/contracts";
import { requestJson } from "@/features/events/api-client";
import type { CustomerPreferences } from "./customer-preferences";

/**
 * Interests and chosen city (XRPL-058).
 *
 * Entirely optional. Skipping leaves an account with no preferences, which
 * every browsing surface already supports, so nothing here gates discovery.
 */
export function PreferencesForm({
  preferences,
  /** Where "Skip" and a successful save go. */
  doneHref = "/",
  showSkip = false,
}: {
  preferences: CustomerPreferences;
  doneHref?: string;
  showSkip?: boolean;
}) {
  const router = useRouter();
  const formId = useId();
  const [selected, setSelected] = useState<EventCategory[]>(preferences.interests);
  const [city, setCity] = useState(preferences.city ?? "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(category: EventCategory) {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
  }

  async function save(next: { interests: EventCategory[]; city: string }) {
    setPending(true);
    setError(null);
    setSaved(false);

    const result = await requestJson<CustomerPreferences>(
      "/api/profiles/customers/me/preferences",
      { method: "PATCH", body: { interests: next.interests, city: next.city } },
    );
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setSaved(true);
    router.refresh();
    return true;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const ok = await save({ interests: selected, city });
    if (ok && doneHref !== "") router.push(doneHref);
  }

  /** Clearing is an explicit action, not an empty save the user has to guess at. */
  async function clearAll() {
    if (pending) return;
    setSelected([]);
    setCity("");
    await save({ interests: [], city: "" });
  }

  const hasSelection = selected.length > 0 || city.trim() !== "";

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-labelledby={`${formId}-heading`}
      className="max-w-2xl rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id={`${formId}-heading`} className="text-lg font-semibold">
        What are you into?
      </h2>
      <p className="mt-1 text-sm text-muted">
        Optional. These only help us order what you see — you can browse everything
        without setting them.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-4 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive">
          Preferences saved.
        </p>
      ) : null}

      <fieldset className="mt-5">
        <legend className="text-sm font-medium">Interests</legend>
        <p className="mt-1 text-sm text-muted">Pick as many as you like.</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {EVENT_CATEGORIES.map((category) => {
            const isOn = selected.includes(category);
            return (
              <li key={category}>
                {/* A real checkbox, so it is reachable and announced correctly;
                    the label carries the visible chip styling. */}
                <label
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                    isOn
                      ? "border-transparent bg-accent text-accent-ink"
                      : "border-border hover:bg-surface"
                  }`}
                >
                  <input
                    type="checkbox"
                    name="interests"
                    value={category}
                    checked={isOn}
                    onChange={() => toggle(category)}
                    className="size-4 accent-current"
                  />
                  {EVENT_CATEGORY_LABELS[category]}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="mt-6">
        <label htmlFor={`${formId}-city`} className="block text-sm font-medium">
          City or region
        </label>
        <input
          id={`${formId}-city`}
          name="city"
          type="text"
          value={city}
          onChange={(event) => setCity(event.target.value)}
          maxLength={80}
          autoComplete="address-level2"
          placeholder="Dublin"
          className="mt-1 w-full max-w-sm rounded-lg border border-border bg-canvas px-3 py-2 text-base"
        />
        <p className="mt-1 text-sm text-muted">
          A city or region you type, nothing more. We never ask for your device
          location.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save preferences"}
        </button>

        {hasSelection ? (
          <button
            type="button"
            onClick={clearAll}
            disabled={pending}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60"
          >
            Clear all
          </button>
        ) : null}

        {showSkip ? (
          <button
            type="button"
            onClick={() => router.push(doneHref)}
            className="text-sm font-medium text-muted underline hover:text-ink"
          >
            Skip for now
          </button>
        ) : null}
      </div>
    </form>
  );
}
