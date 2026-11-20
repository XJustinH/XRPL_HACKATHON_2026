"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { SellerProfilePatch, type SellerProfile, type SocialLink } from "@/contracts";
import { requestJson } from "@/features/events/api-client";
import { FieldError } from "@/features/events/field-error";

/**
 * Seller profile editor (XRPL-055).
 *
 * Posts to `/api/profiles/sellers/me`, which has no way to name another
 * account — a seller can only ever edit their own profile.
 */

type Field = "displayName" | "bio" | "city" | "websiteUrl" | "imageUrl" | "socialLinks";
type FieldErrors = Partial<Record<Field, string>>;

const MAX_LINKS = 6;

type LinkDraft = { label: string; url: string };

/** Drops blank rows, so an untouched empty row is not a validation error. */
export function cleanSocialLinks(drafts: LinkDraft[]): LinkDraft[] {
  return drafts.filter((link) => link.label.trim() !== "" || link.url.trim() !== "");
}

export function SellerProfileForm({ profile }: { profile: SellerProfile }) {
  const router = useRouter();
  const formId = useId();
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const [links, setLinks] = useState<LinkDraft[]>(
    profile.socialLinks.length > 0
      ? profile.socialLinks.map((link) => ({ label: link.label, url: link.url }))
      : [{ label: "", url: "" }],
  );

  const fieldId = (name: Field) => `${formId}-${name}`;
  const errorId = (name: Field) => `${formId}-${name}-error`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setPending(true);
    setFormError(null);
    setSaved(false);

    const presentLinks = cleanSocialLinks(links);
    const errors: FieldErrors = {};
    if (presentLinks.some((link) => link.label.trim() === "" || link.url.trim() === "")) {
      errors.socialLinks = "Give every link both a label and a URL, or clear the row";
    }

    const candidate = {
      displayName: String(formData.get("displayName") ?? ""),
      bio: String(formData.get("bio") ?? ""),
      city: String(formData.get("city") ?? ""),
      websiteUrl: String(formData.get("websiteUrl") ?? ""),
      imageUrl: String(formData.get("imageUrl") ?? ""),
      socialLinks: presentLinks as SocialLink[],
    };

    const parsed = SellerProfilePatch.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const name = issue.path[0];
        if (name === "socialLinks") {
          errors.socialLinks ??= "Every link needs a label and a valid URL";
        } else if (typeof name === "string" && !(name in errors)) {
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

    const result = await requestJson<SellerProfile>("/api/profiles/sellers/me", {
      method: "PATCH",
      body: parsed.success ? parsed.data : candidate,
    });
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
      className="max-w-2xl rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id={`${formId}-heading`} className="text-lg font-semibold">
        Your public profile
      </h2>
      <p className="mt-1 text-sm text-muted">
        Everything here is shown on your public storefront.
      </p>

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

      <div className="mt-5 flex flex-col gap-5">
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
            className={inputClass}
            {...errorProps("displayName")}
          />
          <FieldError id={errorId("displayName")} message={fieldErrors.displayName} />
        </div>

        <div>
          <label htmlFor={fieldId("bio")} className={labelClass}>
            Biography
          </label>
          <textarea
            id={fieldId("bio")}
            name="bio"
            rows={5}
            defaultValue={profile.bio}
            maxLength={1_000}
            className={inputClass}
            {...errorProps("bio")}
          />
          <FieldError id={errorId("bio")} message={fieldErrors.bio} />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor={fieldId("city")} className={labelClass}>
              City
            </label>
            <input
              id={fieldId("city")}
              name="city"
              type="text"
              defaultValue={profile.city ?? ""}
              maxLength={80}
              autoComplete="address-level2"
              className={inputClass}
              {...errorProps("city")}
            />
            <FieldError id={errorId("city")} message={fieldErrors.city} />
          </div>
          <div>
            <label htmlFor={fieldId("websiteUrl")} className={labelClass}>
              Website
            </label>
            <input
              id={fieldId("websiteUrl")}
              name="websiteUrl"
              type="url"
              inputMode="url"
              placeholder="https://"
              defaultValue={profile.websiteUrl ?? ""}
              className={inputClass}
              {...errorProps("websiteUrl")}
            />
            <FieldError id={errorId("websiteUrl")} message={fieldErrors.websiteUrl} />
          </div>
        </div>

        <div>
          <label htmlFor={fieldId("imageUrl")} className={labelClass}>
            Profile image URL
          </label>
          <input
            id={fieldId("imageUrl")}
            name="imageUrl"
            type="url"
            inputMode="url"
            placeholder="https://"
            defaultValue={profile.imageUrl ?? ""}
            className={inputClass}
            {...errorProps("imageUrl")}
          />
          <p className="mt-1 text-sm text-muted">
            Link to an image you have the rights to use. Uploading files arrives with
            XRPL-071.
          </p>
          <FieldError id={errorId("imageUrl")} message={fieldErrors.imageUrl} />
        </div>

        <fieldset>
          <legend className={labelClass}>Social links</legend>
          <p className="mt-1 text-sm text-muted">Up to {MAX_LINKS} links.</p>

          <ul className="mt-3 flex flex-col gap-3">
            {links.map((link, index) => (
              <li key={index} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <input
                  type="text"
                  value={link.label}
                  onChange={(event) =>
                    setLinks(
                      links.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                  aria-label={`Link ${index + 1} label`}
                  placeholder="Instagram"
                  maxLength={40}
                  className={inputClass}
                />
                <input
                  type="url"
                  inputMode="url"
                  value={link.url}
                  onChange={(event) =>
                    setLinks(
                      links.map((item, i) =>
                        i === index ? { ...item, url: event.target.value } : item,
                      ),
                    )
                  }
                  aria-label={`Link ${index + 1} URL`}
                  placeholder="https://"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setLinks(links.filter((_, i) => i !== index))}
                  /* Explicit label: with visible text plus a screen-reader
                     span, the computed name runs the two together. */
                  aria-label={`Remove link ${index + 1}`}
                  className="mt-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          {links.length < MAX_LINKS ? (
            <button
              type="button"
              onClick={() => setLinks([...links, { label: "", url: "" }])}
              className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface"
            >
              Add a link
            </button>
          ) : null}

          <FieldError id={errorId("socialLinks")} message={fieldErrors.socialLinks} />
        </fieldset>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}
