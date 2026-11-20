"use client";

import { useState } from "react";

import type { TransactionRequest } from "@/contracts/xrpl";

import { notice, secondaryButton } from "./styles";
import { TransactionApproval } from "./transaction-approval";

/**
 * Developer check (XRPL-014): sign a no-op AccountSet to exercise approval, submission,
 * validation and the explorer link before mint/offer/purchase actions exist.
 * Rendered only when the server enables test transactions.
 */
export function TestTransactionCheck({
  address,
  pollIntervalMs,
}: {
  address: string;
  pollIntervalMs?: number;
}) {
  const [request, setRequest] = useState<TransactionRequest | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/wallet/transaction-requests", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ purpose: "TEST", account: address }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as { data?: TransactionRequest };
      if (!response.ok || !body.data) throw new Error(`HTTP ${response.status}`);
      setRequest(body.data);
    } catch {
      setError("Couldn't create the test transaction. Try again in a moment.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mt-5 border-t border-border pt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">Developer check</p>
      <p className="mt-1 text-sm text-muted">
        Approve a no-op transaction to check signing, submission and confirmation end to end. It needs an
        account that is active on the network.
      </p>
      {request ? (
        <div className="mt-3">
          <TransactionApproval
            key={request.id}
            request={request}
            title="Approve the test transaction"
            onRetry={() => void start()}
            pollIntervalMs={pollIntervalMs}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className={`${secondaryButton} mt-3`}
        >
          {starting ? "Preparing…" : "Send a test transaction"}
        </button>
      )}
      {error ? (
        <p role="alert" className={`mt-3 ${notice.critical}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
