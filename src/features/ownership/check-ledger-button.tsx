"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { TicketReconcileResult } from "@/contracts";
import { callApi } from "@/features/transfers/api";
import { notice, secondaryButton } from "@/features/wallet/styles";

/**
 * "Check the ledger again" (XRPL-043): asks the server to bring this ticket in step with the XRP Ledger
 * (`POST /api/tickets/:id/reconcile`), then re-renders the page with the result. Listings the ledger
 * no longer backs are closed, for example the previous holder's after the ticket moved.
 */
export function CheckLedgerButton({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "positive" | "critical"; text: string } | null>(null);

  async function check() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await callApi<TicketReconcileResult>(`/api/tickets/${ticketId}/reconcile`, { method: "POST" });
      const closed = result.offers.filter((o) => o.previousState !== o.state && o.state !== "ACCEPTED").length;
      setMessage({
        tone: "positive",
        text: [
          result.ownership.changed ? "This ticket has a new holder since it was last checked." : "Up to date with the ledger.",
          closed > 0 ? `${closed} listing${closed === 1 ? "" : "s"} the ledger no longer backs ${closed === 1 ? "was" : "were"} closed.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "critical", text: error instanceof Error ? error.message : "The ledger couldn't be checked." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={check} disabled={busy} className={`${secondaryButton} min-h-11 self-start`}>
        {busy ? "Checking the ledger…" : "Check the ledger again"}
      </button>
      {message ? (
        <p role={message.tone === "critical" ? "alert" : "status"} className={notice[message.tone]}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
