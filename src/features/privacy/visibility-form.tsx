"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { requestJson } from "@/features/events/api-client";
import type { ActivityVisibility, VisibilitySettings } from "./visibility";

/**
 * Attendance and saved-event sharing controls (XRPL-088).
 *
 * Both default to "Only me". The copy states what turning a setting on actually
 * discloses, because "share with friends" on its own does not tell someone what
 * their friends will be able to see.
 */

const OPTIONS: { value: ActivityVisibility; label: string; hint: string }[] = [
  { value: "ONLY_ME", label: "Only me", hint: "Nobody else can see it." },
  {
    value: "FRIENDS",
    label: "My friends",
    hint: "Accepted friends only. Never anyone else, and never publicly.",
  },
];

function Choice({
  name,
  legend,
  description,
  value,
  onChange,
  disabled,
}: {
  name: string;
  legend: string;
  description: string;
  value: ActivityVisibility;
  onChange: (next: ActivityVisibility) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="border-t border-border pt-4">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="mt-1 text-sm text-muted">{description}</p>
      <div className="mt-3 flex flex-col gap-2">
        {OPTIONS.map((option) => (
          <label key={option.value} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name={`${name}-${id}`}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              disabled={disabled}
              className="mt-1 size-4"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function VisibilityForm({ settings }: { settings: VisibilitySettings }) {
  const router = useRouter();
  const [attendance, setAttendance] = useState(settings.attendanceVisibility);
  const [wishlist, setWishlist] = useState(settings.wishlistVisibility);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const overrideCount = Object.keys(settings.eventVisibility).length;

  async function save(next: {
    attendanceVisibility: ActivityVisibility;
    wishlistVisibility: ActivityVisibility;
  }) {
    setPending(true);
    setError(null);
    setSaved(false);

    const result = await requestJson<VisibilitySettings>("/api/privacy/event-visibility", {
      method: "PATCH",
      body: next,
    });
    setPending(false);

    if (!result.ok) {
      // Revert so the control never claims a setting that was not stored.
      setAttendance(settings.attendanceVisibility);
      setWishlist(settings.wishlistVisibility);
      setError(result.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <section
      aria-labelledby="visibility-heading"
      className="max-w-2xl rounded-card border border-border bg-surface-raised p-5"
    >
      <h2 id="visibility-heading" className="text-lg font-semibold">
        Attendance and saved events
      </h2>
      <p className="mt-1 text-sm text-muted">
        Both are private until you change them. These settings only ever affect what
        accepted friends can see — nothing here is public.
      </p>

      {error ? (
        <p role="alert" className="mt-4 rounded-lg bg-critical-soft px-4 py-3 text-sm text-critical">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-4 rounded-lg bg-positive-soft px-4 py-3 text-sm text-positive">
          Saved.
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-5">
        <Choice
          name="attendance"
          legend="Events I have attended"
          description="Whether friends can see that you were checked in at an event."
          value={attendance}
          disabled={pending}
          onChange={(next) => {
            setAttendance(next);
            void save({ attendanceVisibility: next, wishlistVisibility: wishlist });
          }}
        />
        <Choice
          name="wishlist"
          legend="Events I have saved"
          description="Whether friends can see that you are interested in an event."
          value={wishlist}
          disabled={pending}
          onChange={(next) => {
            setWishlist(next);
            void save({ attendanceVisibility: attendance, wishlistVisibility: next });
          }}
        />
      </div>

      {overrideCount > 0 ? (
        <p className="mt-5 border-t border-border pt-4 text-sm text-muted">
          You have set a different choice for {overrideCount}{" "}
          {overrideCount === 1 ? "event" : "events"}. Those override the settings above —
          change them on the event&apos;s own page.
        </p>
      ) : null}
    </section>
  );
}
