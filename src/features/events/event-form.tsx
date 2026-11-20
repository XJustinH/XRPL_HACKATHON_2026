"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { EventDraftInput, type EventView } from "@/contracts";
import { postJson } from "@/features/onboarding/post-json";

/**
 * Seller event creation form (XRPL-015).
 *
 * Validates on submit with the shared contract schema, so the rules the server
 * enforces and the messages shown here cannot drift apart. The server
 * re-validates regardless — this is a usability layer, not a security one.
 */

type Field = "title" | "description" | "startsAt" | "endsAt" | "venue" | "city" | "artworkUrl";

type FieldErrors = Partial<Record<Field, string>>;

/**
 * Converts a `datetime-local` value to a UTC ISO string with offset.
 *
 * The input yields wall-clock time with no zone ("2026-12-01T20:00"), which the
 * contract rejects. Interpreting it in the browser's zone is the intended
 * behaviour: a seller enters the local start time at the venue.
 */
export function localInputToUtcIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Formats a UTC ISO string back into a `datetime-local` value. */
export function utcIsoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm text-critical">
      {message}
    </p>
  );
}

export function EventForm() {
  const router = useRouter();
  const formId = useId();
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const fieldId = (name: Field) => `${formId}-${name}`;
  const errorId = (name: Field) => `${formId}-${name}-error`;

  /*
   * Submission is handled with preventDefault rather than React's `action`
   * prop: a form action resets uncontrolled inputs once it resolves, which
   * would wipe everything the seller typed whenever the server rejected the
   * request. Their input has to survive an error so they can correct and retry.
   */
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);

    const startsAtLocal = String(formData.get("startsAt") ?? "");
    const endsAtLocal = String(formData.get("endsAt") ?? "");
    const startsAt = localInputToUtcIso(startsAtLocal);
    const endsAt = localInputToUtcIso(endsAtLocal);

    // The date inputs need their own checks: an unparseable value never reaches
    // the schema, and "ends before it starts" is a cross-field rule.
    const dateErrors: FieldErrors = {};
    if (!startsAtLocal) dateErrors.startsAt = "Start date and time is required";
    else if (!startsAt) dateErrors.startsAt = "Enter a valid date and time";
    if (endsAtLocal && !endsAt) dateErrors.endsAt = "Enter a valid date and time";
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      dateErrors.endsAt = "End time must be after the start time";
    }

    const candidate = {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      startsAt: startsAt ?? "",
      endsAt,
      venue: String(formData.get("venue") ?? ""),
      city: String(formData.get("city") ?? ""),
      artworkUrl: String(formData.get("artworkUrl") ?? ""),
    };

    const parsed = EventDraftInput.safeParse(candidate);
    const errors: FieldErrors = { ...dateErrors };
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const name = issue.path[0];
        if (typeof name === "string" && !(name in errors)) {
          errors[name as Field] = issue.message;
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setPending(false);
      return;
    }
    setFieldErrors({});

    const result = await postJson<EventView>("/api/events", parsed.data);
    if (!result.ok) {
      setFormError(result.message);
      setPending(false);
      return;
    }

    router.push(`/seller/events`);
    router.refresh();
  }

  function errorProps(name: Field) {
    const message = fieldErrors[name];
    return {
      "aria-invalid": message ? (true as const) : undefined,
      "aria-describedby": message ? errorId(name) : undefined,
    };
  }

  const inputClass =
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical";
  const labelClass = "block text-sm font-medium";

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="max-w-2xl rounded-card border border-border bg-surface-raised p-5"
    >
      {formError ? (
        <p role="alert" className="mb-5 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        <div>
          <label htmlFor={fieldId("title")} className={labelClass}>
            Event name <span className="text-muted">(required)</span>
          </label>
          <input
            id={fieldId("title")}
            name="title"
            type="text"
            required
            maxLength={120}
            autoComplete="off"
            className={inputClass}
            {...errorProps("title")}
          />
          <FieldError id={errorId("title")} message={fieldErrors.title} />
        </div>

        <div>
          <label htmlFor={fieldId("description")} className={labelClass}>
            Description
          </label>
          <textarea
            id={fieldId("description")}
            name="description"
            rows={4}
            maxLength={4_000}
            className={inputClass}
            {...errorProps("description")}
          />
          <p className="mt-1 text-sm text-muted">
            Shown on the public event page once you publish.
          </p>
          <FieldError id={errorId("description")} message={fieldErrors.description} />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId("startsAt")} className={labelClass}>
              Starts <span className="text-muted">(required)</span>
            </label>
            <input
              id={fieldId("startsAt")}
              name="startsAt"
              type="datetime-local"
              required
              className={inputClass}
              {...errorProps("startsAt")}
            />
            <FieldError id={errorId("startsAt")} message={fieldErrors.startsAt} />
          </div>
          <div>
            <label htmlFor={fieldId("endsAt")} className={labelClass}>
              Ends
            </label>
            <input
              id={fieldId("endsAt")}
              name="endsAt"
              type="datetime-local"
              className={inputClass}
              {...errorProps("endsAt")}
            />
            <FieldError id={errorId("endsAt")} message={fieldErrors.endsAt} />
          </div>
        </div>
        <p className="-mt-2 text-sm text-muted">
          Times are in your device&apos;s timezone and stored in UTC.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId("venue")} className={labelClass}>
              Venue <span className="text-muted">(required)</span>
            </label>
            <input
              id={fieldId("venue")}
              name="venue"
              type="text"
              required
              maxLength={160}
              className={inputClass}
              {...errorProps("venue")}
            />
            <FieldError id={errorId("venue")} message={fieldErrors.venue} />
          </div>
          <div>
            <label htmlFor={fieldId("city")} className={labelClass}>
              City <span className="text-muted">(required)</span>
            </label>
            <input
              id={fieldId("city")}
              name="city"
              type="text"
              required
              maxLength={80}
              autoComplete="address-level2"
              className={inputClass}
              {...errorProps("city")}
            />
            <FieldError id={errorId("city")} message={fieldErrors.city} />
          </div>
        </div>

        <div>
          <label htmlFor={fieldId("artworkUrl")} className={labelClass}>
            Artwork URL
          </label>
          <input
            id={fieldId("artworkUrl")}
            name="artworkUrl"
            type="url"
            inputMode="url"
            placeholder="https://"
            className={inputClass}
            {...errorProps("artworkUrl")}
          />
          <p className="mt-1 text-sm text-muted">
            Link to an image you have the rights to use. Leave empty to add it later.
          </p>
          <FieldError id={errorId("artworkUrl")} message={fieldErrors.artworkUrl} />
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save draft"}
        </button>
        <p className="text-sm text-muted">
          Saved as a draft. Nothing is public and no tickets are minted yet.
        </p>
      </div>
    </form>
  );
}
