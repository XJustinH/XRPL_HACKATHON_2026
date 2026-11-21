"use client";

import { useState } from "react";
import { REPORT_REASON_LABELS, type ReportReason, type ReportView } from "@/contracts/community";
import { Badge } from "@/components/ui/badge";
import { requestJson } from "@/features/events/api-client";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { formatDate } from "./client";

/**
 * Open reports with the two decisions a moderator can make (XRPL-083): hide the content, or
 * dismiss the report. Hiding keeps the row and removes it from public view.
 */
export function ModerationQueue({ initial }: { initial: ReportView[] }) {
  const [reports, setReports] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(report: ReportView, action: "HIDE" | "DISMISS") {
    if (pendingId) return;
    setPendingId(report.id);
    setError(null);
    const result = await requestJson<{ id: string }>(`/api/moderation/reports/${report.id}/resolve`, {
      method: "POST",
      body: { action },
    });
    setPendingId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Hiding closes every open report about the same item.
    setReports((current) =>
      current.filter((item) =>
        action === "HIDE"
          ? !(item.targetType === report.targetType && item.targetId === report.targetId)
          : item.id !== report.id,
      ),
    );
  }

  if (reports.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-border bg-surface px-5 py-6 text-center text-sm text-muted">
        No open reports.
      </p>
    );
  }

  return (
    <>
      {error ? (
        <p role="alert" className={`mb-3 ${notice.critical}`}>
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3" aria-label="Open reports">
        {reports.map((report) => (
          <li key={report.id} className={card}>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="caution">{REPORT_REASON_LABELS[report.reason as ReportReason] ?? report.reason}</Badge>
              <span className="text-muted">
                Reported by {report.reporter.displayName} on {formatDate(report.createdAt)}
              </span>
            </p>
            {report.target ? (
              <>
                <p className="mt-2 text-sm font-semibold">
                  {report.target.context} · written by {report.target.author.displayName}
                  {report.target.hidden ? " · already hidden" : ""}
                </p>
                <blockquote className="mt-1 whitespace-pre-line break-words border-l-2 border-border pl-3 text-sm">
                  {report.target.excerpt}
                </blockquote>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted">This content has since been deleted.</p>
            )}
            {report.details ? <p className="mt-2 text-sm text-muted">Reporter&apos;s note: {report.details}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {report.target ? (
                <button
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => resolve(report, "HIDE")}
                  className={`min-h-11 ${primaryButton}`}
                >
                  Hide content
                </button>
              ) : null}
              <button
                type="button"
                disabled={pendingId !== null}
                onClick={() => resolve(report, "DISMISS")}
                className={`min-h-11 ${secondaryButton}`}
              >
                Dismiss report
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
