"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { EVENT_CATEGORIES, EVENT_CATEGORY_LABELS, EventPatch, type EventView } from "@/contracts";
import { requestJson } from "./api-client";
import { FieldError } from "./field-error";
import { localInputToUtcIso, utcIsoToLocalInput } from "./event-form";
import { NFT_RELEVANT_FIELDS, hasMintedTickets } from "./publish-rules";

/**
 * Edit an existing event's details (XRPL-017).
 *
 * Once tickets are minted, the fields written into NFT metadata are frozen and
 * rendered read-only with an explanation. The server enforces the same rule, so
 * a request that bypasses this form is still rejected. The category isn't in the
 * metadata, so it stays editable.
 */

type Field = "title" | "description" | "startsAt" | "endsAt" | "venue" | "city" | "artworkUrl" | "category";
type FieldErrors = Partial<Record<Field, string>>;

const LOCKABLE = new Set<string>(NFT_RELEVANT_FIELDS);

export function EventDetailsForm({ event: initialEvent }: { event: EventView }) {
  const router = useRouter();
  const formId = useId();
  const [event, setEvent] = useState(initialEvent);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const minted = hasMintedTickets(event);
  const isLocked = (field: Field) => minted && LOCKABLE.has(field);

  const fieldId = (name: Field) => `${formId}-${name}`;
  const errorId = (name: Field) => `${formId}-${name}-error`;

  async function handleSubmit(submitEvent: React.FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    if (pending) return;
    const formData = new FormData(submitEvent.currentTarget);
    setPending(true);
    setFormError(null);
    setSaved(false);

    const startsAtLocal = String(formData.get("startsAt") ?? "");
    const endsAtLocal = String(formData.get("endsAt") ?? "");
    const startsAt = localInputToUtcIso(startsAtLocal);
    const endsAt = localInputToUtcIso(endsAtLocal);

    const errors: FieldErrors = {};
    if (!minted) {
      if (!startsAtLocal) errors.startsAt = "Start date and time is required";
      else if (!startsAt) errors.startsAt = "Enter a valid date and time";
      if (endsAtLocal && !endsAt) errors.endsAt = "Enter a valid date and time";
      if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
        errors.endsAt = "End time must be after the start time";
      }
    }

    /*
     * A locked field is never sent. Submitting its unchanged value would be
     * harmless but would rely on the server's equality check rather than this
     * form simply not touching it.
     */
    const candidate: Record<string, unknown> = {};
    if (!minted) {
      candidate.title = String(formData.get("title") ?? "");
      candidate.description = String(formData.get("description") ?? "");
      candidate.startsAt = startsAt ?? "";
      candidate.endsAt = endsAt;
      candidate.venue = String(formData.get("venue") ?? "");
      candidate.city = String(formData.get("city") ?? "");
      candidate.artworkUrl = String(formData.get("artworkUrl") ?? "");
    }
    // Never locked: "No category" submits an empty value, stored as null.
    candidate.category = String(formData.get("category") ?? "") || null;

    const parsed = EventPatch.safeParse(candidate);
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

    /*
     * Send only the keys this form actually set. `EventPatch` carries defaults
     * from the draft schema, so parsing `{ description }` alone also yields
     * `endsAt: null` — which on an event that has an end time would read as a
     * change to a frozen field and be refused.
     */
    const parsedData = parsed.data as Record<string, unknown>;
    const body = Object.fromEntries(
      Object.keys(candidate).map((key) => [key, parsedData[key]]),
    );

    const result = await requestJson<EventView>(`/api/events/${event.id}`, {
      method: "PATCH",
      body,
    });
    setPending(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setEvent(result.data);
    setSaved(true);
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
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical disabled:opacity-60";
  const labelClass = "block text-sm font-medium";

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-labelledby={`${formId}-heading`}
      className="rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id={`${formId}-heading`} className="text-lg font-semibold">
        Event details
      </h2>

      {minted ? (
        <p className="mt-3 rounded-lg bg-caution-soft px-4 py-3 text-sm text-caution">
          Tickets for this event are already on the ledger. Each one carries the event
          name, description, times, venue, city and artwork in its own metadata, which
          cannot be rewritten — so these details are now fixed. To change them you would
          need a new event. The category isn&apos;t part of the tickets, so you can still change it.
        </p>
      ) : null}

      {formError ? (
        <p role="alert" className="mt-3 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">
          {formError}
        </p>
      ) : null}

      {saved ? (
        <p role="status" className="mt-3 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive">
          Changes saved.
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-5">
        <div>
          <label htmlFor={fieldId("title")} className={labelClass}>
            Event name
          </label>
          <input
            id={fieldId("title")}
            name="title"
            type="text"
            defaultValue={event.title}
            disabled={isLocked("title")}
            maxLength={120}
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
            defaultValue={event.description}
            disabled={isLocked("description")}
            maxLength={4_000}
            className={inputClass}
            {...errorProps("description")}
          />
          <FieldError id={errorId("description")} message={fieldErrors.description} />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId("startsAt")} className={labelClass}>
              Starts
            </label>
            <input
              id={fieldId("startsAt")}
              name="startsAt"
              type="datetime-local"
              defaultValue={utcIsoToLocalInput(event.startsAt)}
              disabled={isLocked("startsAt")}
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
              defaultValue={utcIsoToLocalInput(event.endsAt)}
              disabled={isLocked("endsAt")}
              className={inputClass}
              {...errorProps("endsAt")}
            />
            <FieldError id={errorId("endsAt")} message={fieldErrors.endsAt} />
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId("venue")} className={labelClass}>
              Venue
            </label>
            <input
              id={fieldId("venue")}
              name="venue"
              type="text"
              defaultValue={event.venue}
              disabled={isLocked("venue")}
              maxLength={160}
              className={inputClass}
              {...errorProps("venue")}
            />
            <FieldError id={errorId("venue")} message={fieldErrors.venue} />
          </div>
          <div>
            <label htmlFor={fieldId("city")} className={labelClass}>
              City
            </label>
            <input
              id={fieldId("city")}
              name="city"
              type="text"
              defaultValue={event.city}
              disabled={isLocked("city")}
              maxLength={80}
              className={inputClass}
              {...errorProps("city")}
            />
            <FieldError id={errorId("city")} message={fieldErrors.city} />
          </div>
        </div>

        <div>
          <label htmlFor={fieldId("category")} className={labelClass}>
            Category
          </label>
          <select
            id={fieldId("category")}
            name="category"
            defaultValue={event.category ?? ""}
            className={inputClass}
            {...errorProps("category")}
          >
            <option value="">No category</option>
            {EVENT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {EVENT_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
          <FieldError id={errorId("category")} message={fieldErrors.category} />
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
            defaultValue={event.artworkUrl ?? ""}
            disabled={isLocked("artworkUrl")}
            placeholder="https://"
            className={inputClass}
            {...errorProps("artworkUrl")}
          />
          <FieldError id={errorId("artworkUrl")} message={fieldErrors.artworkUrl} />
        </div>
      </div>

      {/* Shown even once minting starts: the category is still editable then. */}
      <div className="mt-6 border-t border-border pt-5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : minted ? "Save category" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
