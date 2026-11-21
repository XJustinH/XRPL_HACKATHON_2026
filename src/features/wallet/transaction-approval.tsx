"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  FINAL_TRANSACTION_REQUEST_STATUSES,
  type TransactionRequest,
  type TransactionRequestStatus,
} from "@/contracts/xrpl";

import { NETWORK_LABEL, notice, primaryButton, secondaryButton } from "./styles";

const isFinal = (status: TransactionRequestStatus) => FINAL_TRANSACTION_REQUEST_STATUSES.includes(status);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

async function callApi(input: string, init?: RequestInit): Promise<TransactionRequest> {
  const response = await fetch(input, {
    ...init,
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as { data?: TransactionRequest };
  if (!response.ok || !body.data) throw new Error(`HTTP ${response.status}`);
  return body.data;
}

/** Follows a transaction request until it reaches a final status. */
export function useTransactionRequest(initial: TransactionRequest, pollIntervalMs = 2000) {
  const [request, setRequest] = useState(initial);
  const [lostContact, setLostContact] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      let current = initial;
      let failures = 0;
      while (active && !isFinal(current.status)) {
        await sleep(pollIntervalMs);
        if (!active) return;
        try {
          current = await callApi(`/api/wallet/transaction-requests/${initial.id}`);
          failures = 0;
          if (!active) return;
          setLostContact(false);
          const latest = current;
          // Never let a late poll overwrite a final state (e.g. right after Cancel).
          setRequest((previous) => (isFinal(previous.status) ? previous : latest));
        } catch {
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_POLL_FAILURES && active) setLostContact(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [initial, pollIntervalMs]);

  const cancel = useCallback(async () => {
    try {
      setRequest(await callApi(`/api/wallet/transaction-requests/${initial.id}`, { method: "DELETE" }));
    } catch {
      setLostContact(true);
    }
  }, [initial.id]);

  return { request, lostContact, cancel };
}

const STEPS = ["Approve in Xaman", "Submitted to the XRP Ledger", "Confirmed"] as const;

function stepOf(status: TransactionRequestStatus): number {
  if (status === "CONFIRMED") return 2;
  if (status === "SUBMITTED" || status === "FAILED") return 1;
  return 0;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function outcomeOf(request: TransactionRequest): { tone: "caution" | "critical"; text: string } | null {
  switch (request.status) {
    case "REJECTED":
      return { tone: "caution", text: "You declined the request in Xaman. Nothing was sent." };
    case "EXPIRED":
      return { tone: "caution", text: "The request expired before it was approved. Nothing was sent." };
    case "CANCELLED":
      return { tone: "caution", text: "Request cancelled. Nothing was sent." };
    case "FAILED":
      switch (request.failureReason) {
        case "LEDGER_REJECTED":
          if (request.engineResult === "tecINSUFFICIENT_RESERVE") {
            return {
              tone: "critical",
              text: "The XRP Ledger rejected the transaction: your wallet doesn't hold enough XRP for the reserve it needs (tecINSUFFICIENT_RESERVE). Add XRP to the wallet and try again. The small network fee was charged; nothing else changed.",
            };
          }
          return {
            tone: "critical",
            text: `The XRP Ledger rejected the transaction (${request.engineResult ?? "unknown result"}). The small network fee was charged; nothing else changed.`,
          };
        case "NETWORK_REJECTED":
          return {
            tone: "critical",
            text: `The network refused the transaction (${request.engineResult ?? "unknown result"}). Nothing was charged.`,
          };
        case "NOT_VALIDATED_IN_TIME":
          return {
            tone: "critical",
            text: "The transaction wasn't validated before it expired. Nothing was charged.",
          };
        case "WRONG_NETWORK":
          return {
            tone: "critical",
            text: `Your wallet signed on a different network. Switch Xaman to ${NETWORK_LABEL} and try again.`,
          };
        default:
          return { tone: "critical", text: "The transaction failed." };
      }
    default:
      return null;
  }
}

/**
 * Approval and status for one wallet transaction (XRPL-014): approve in Xaman, then
 * submitted, then confirmed on a validated ledger with an explorer link. Failed, declined,
 * expired and cancelled requests explain what happened and offer `onRetry`.
 * Mint, offer and purchase screens render this with the request their route returns, and
 * use `onFinished` (called once, with the final request) to refresh their own state.
 */
export function TransactionApproval({
  request: initial,
  title = "Approve in Xaman",
  onRetry,
  onFinished,
  pollIntervalMs,
}: {
  request: TransactionRequest;
  title?: string;
  onRetry?: () => void;
  onFinished?: (request: TransactionRequest) => void;
  pollIntervalMs?: number;
}) {
  const { request, lostContact, cancel } = useTransactionRequest(initial, pollIntervalMs);
  const onFinishedRef = useRef(onFinished);
  const finishedId = useRef<string | null>(null);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);
  useEffect(() => {
    if (!isFinal(request.status) || finishedId.current === request.id) return;
    finishedId.current = request.id;
    onFinishedRef.current?.(request);
  }, [request]);
  const current = stepOf(request.status);
  const outcome = outcomeOf(request);
  const waitingForWallet = request.status === "PENDING" || request.status === "OPENED";

  return (
    <section className="rounded-lg border border-border p-4" aria-label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {request.instruction ? <p className="mt-1 text-sm text-muted">{request.instruction}</p> : null}

      <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Progress">
        {STEPS.map((label, index) => {
          const done = index < current || request.status === "CONFIRMED";
          return (
            <li
              key={label}
              aria-current={index === current && !isFinal(request.status) ? "step" : undefined}
              className={done ? "text-positive" : index === current ? "font-semibold text-ink" : "text-muted"}
            >
              {index + 1}. {label}
              {done ? " ✓" : ""}
            </li>
          );
        })}
      </ol>

      {waitingForWallet ? (
        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- Xaman serves this QR image; next/image would need a remote pattern in next.config. */}
          <img
            src={request.qrPngUrl}
            alt="QR code for the Xaman transaction request"
            width={180}
            height={180}
            className="rounded-lg border border-border bg-white p-2"
          />
          <div className="flex w-full flex-col gap-3 text-sm sm:w-auto">
            <p role="status" className="text-muted">
              {request.status === "OPENED"
                ? "Opened in Xaman. Review the details there, then approve or reject."
                : "Scan the QR code with Xaman, or open the request on this device. Check the details before approving."}
            </p>
            <a href={request.signUrl} target="_blank" rel="noopener noreferrer" className={primaryButton}>
              Open in Xaman
            </a>
            {request.expiresAt ? (
              <p className="text-muted">
                Expires at{" "}
                <time dateTime={request.expiresAt}>
                  {new Date(request.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </time>
              </p>
            ) : null}
            <button type="button" onClick={() => void cancel()} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {request.status === "SUBMITTED" ? (
        <p role="status" className="mt-4 text-sm text-muted">
          Signed and submitted. Waiting for the XRP Ledger to validate it, usually a few seconds.
          {request.txHash ? (
            <span className="ml-1 font-mono text-xs">{shortHash(request.txHash)}</span>
          ) : null}
        </p>
      ) : null}

      {request.status === "CONFIRMED" ? (
        <div role="status" className={`mt-4 ${notice.positive}`}>
          <p className="font-semibold">Confirmed on {NETWORK_LABEL}.</p>
          {request.explorerUrl ? (
            <a href={request.explorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
              View on the XRPL explorer
            </a>
          ) : null}
          {request.txHash ? (
            <span className="ml-2 font-mono text-xs">{shortHash(request.txHash)}</span>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        <div className="mt-4 flex flex-col gap-3">
          <p role="alert" className={notice[outcome.tone]}>
            {outcome.text}
            {request.status === "FAILED" && request.explorerUrl ? (
              <>
                {" "}
                <a href={request.explorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  View on the XRPL explorer
                </a>
              </>
            ) : null}
          </p>
          {onRetry ? (
            <div>
              <button type="button" onClick={onRetry} className={primaryButton}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {lostContact && !isFinal(request.status) ? (
        <p role="alert" className={`mt-4 ${notice.caution}`}>
          Lost contact with the server. If you approve in Xaman the transaction can still complete; this will
          update once the connection is back.
        </p>
      ) : null}
    </section>
  );
}
