"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { CustomerProfilePatch, safeExternalUrl } from "@/contracts";
import { requestJson } from "@/features/events/api-client";
import { FieldError } from "@/features/events/field-error";
import type { OwnCustomerProfile } from "./customer-profile";

/**
 * Edit your own display name and avatar (XRPL-056). Posts to `/api/profiles/customers/me`, which
 * has no way to name another account. Mirrors the seller profile form (XRPL-055).
 */

type Field = "displayName" | "imageUrl";
type FieldErrors = Partial<Record<Field, string>>;

const Patch = CustomerProfilePatch.pick({ displayName: true, imageUrl: true });

export function CustomerProfileForm({ profile }: { profile: Pick<OwnCustomerProfile, "displayName" | "imageUrl"> }) {
  const router = useRouter();
  const formId = useId();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [imageDraft, setImageDraft] = useState(profile.imageUrl ?? "");

  const fieldId = (name: Field) => `${formId}-${name}`;
  const errorId = (name: Field) => `${formId}-${name}-error`;
  const preview = safeExternalUrl(imageDraft.trim());

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setSaved(false);
    setFormError(null);

    const parsed = Patch.safeParse({
      displayName: String(formData.get("displayName") ?? ""),
      imageUrl: String(formData.get("imageUrl") ?? "").trim(),
    });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const name = issue.path[0];
        if ((name === "displayName" || name === "imageUrl") && !(name in errors)) {
          errors[name] = name === "displayName" ? "Use 2 to 80 characters" : "Use a full https:// link to an image, or leave it empty";
        }
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setPending(true);
    const result = await requestJson<OwnCustomerProfile>("/api/profiles/customers/me", { method: "PATCH", body: parsed.data });
    setPending(false);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
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
    "mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-base aria-invalid:border-critical";
  const labelClass = "block text-sm font-medium";

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      aria-labelledby={`${formId}-heading`}
      className="mt-6 rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id={`${formId}-heading`} className="text-lg font-semibold">
        Edit profile
      </h2>

      {formError ? (
        <p role="alert" className="mt-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">
          {formError}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-4 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive">
          Profile saved.
        </p>
      ) : null}

      <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-5">
          <div>
            <label htmlFor={fieldId("displayName")} className={labelClass}>
              Display name
            </label>
            <input
              id={fieldId("displayName")}
              name="displayName"
              type="text"
              defaultValue={profile.displayName}
              maxLength={80}
              autoComplete="nickname"
              className={inputClass}
              {...errorProps("displayName")}
            />
            <FieldError id={errorId("displayName")} message={fieldErrors.displayName} />
          </div>
          <div>
            <label htmlFor={fieldId("imageUrl")} className={labelClass}>
              Avatar image link (optional)
            </label>
            <input
              id={fieldId("imageUrl")}
              name="imageUrl"
              type="url"
              inputMode="url"
              placeholder="https://"
              value={imageDraft}
              onChange={(e) => setImageDraft(e.target.value)}
              className={inputClass}
              {...errorProps("imageUrl")}
            />
            <FieldError id={errorId("imageUrl")} message={fieldErrors.imageUrl} />
          </div>
        </div>
        <Avatar url={preview} name={profile.displayName} size="lg" />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-5 min-h-11 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

/** Round avatar, or the name's first letter when there is no (safe) image. */
export function Avatar({ url, name, size = "md" }: { url: string | null; name: string; size?: "md" | "lg" }) {
  const box = size === "lg" ? "size-20 text-2xl" : "size-12 text-lg";
  const safe = safeExternalUrl(url);
  return safe ? (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-supplied host
    <img src={safe} alt="" className={`${box} shrink-0 rounded-full border border-border object-cover`} />
  ) : (
    <span
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent`}
    >
      {name.trim().slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
