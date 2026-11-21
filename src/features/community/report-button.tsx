"use client";

import { useId, useState } from "react";
import {
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  type ReportReason,
  type ReportTargetType,
} from "@/contracts/community";
import { requestJson } from "@/features/events/api-client";
import { failureMessage, linkButton } from "./client";

/**
 * "Report" control for a review, comment or post (XRPL-083). Opens a short inline form: a reason
 * and optional details. Show it to signed-in users only; the server rejects everyone else anyway.
 */
export function ReportButton({ targetType, targetId }: { targetType: ReportTargetType; targetId: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason>("SPAM");
  const [details, setDetails] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await requestJson<{ id: string }>("/api/reports", {
      method: "POST",
      body: { targetType, targetId, reason, details },
    });
    setPending(false);
    if (!result.ok) {
      setError(failureMessage(result));
      return;
    }
    setSent(true);
    setOpen(false);
  }

  if (sent) {
    return (
      <p role="status" className="text-sm text-muted">
        Reported. Thanks, a moderator will take a look.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={linkButton}>
        Report
      </button>
    );
  }

  return (
    <form onSubmit={submit} aria-label="Report this content" className="mt-2 flex w-full flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <label htmlFor={`${id}-reason`} className="font-medium">
        Why are you reporting this?
      </label>
      <select
        id={`${id}-reason`}
        value={reason}
        onChange={(event) => setReason(event.target.value as ReportReason)}
        className="min-h-11 rounded-lg border border-border bg-canvas px-3"
      >
        {REPORT_REASONS.map((value) => (
          <option key={value} value={value}>
            {REPORT_REASON_LABELS[value]}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-details`}>Details (optional)</label>
      <textarea
        id={`${id}-details`}
        value={details}
        onChange={(event) => setDetails(event.target.value)}
        maxLength={REPORT_DETAILS_MAX}
        rows={2}
        className="rounded-lg border border-border bg-canvas px-3 py-2"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send report"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface">
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-critical">
          {error}
        </p>
      ) : null}
    </form>
  );
}
