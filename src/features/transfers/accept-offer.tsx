"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import {
  TICKET_TAKEN_REASONS,
  type OfferStatus,
  type PurchaseRefusalReason,
  type PurchaseRequestResult,
  type TransactionRequest,
} from "@/contracts/xrpl";
import { notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { ApiError, callApi, newIdempotencyKey } from "./api";

type State =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "approving"; result: PurchaseRequestResult }
  | { phase: "checking" }
  | { phase: "done"; status: OfferStatus }
  | { phase: "gone"; message: string }
  | { phase: "error"; message: string };

const GONE_MESSAGE = "This offer is no longer open. The ticket may have been taken or the offer withdrawn.";

/**
 * Accepting a holder's offer: buying a resale ticket (XRPL-039), or taking a private sale or gift
 * addressed to this wallet (XRPL-040/041). The accepter approves an `NFTokenAcceptOffer` in Xaman;
 * the ticket is theirs only once the ledger validated it (read back from `GET /api/offers/:id`).
 *
 * When the ticket goes to someone else first (XRPL-035), it says so instead of offering to try the
 * same offer again, and links to `otherTicketsHref` (the event's other resale tickets) when given.
 */
export function AcceptOffer({
  offerId,
  kind,
  amountDrops,
  otherTicketsHref,
  pollIntervalMs,
}: {
  offerId: string;
  kind: "RESALE" | "PRIVATE" | "GIFT";
  amountDrops: string;
  /** Where a buyer who lost a resale ticket can look for another. */
  otherTicketsHref?: string;
  pollIntervalMs?: number;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const unanswered = useRef<string | null>(null);
  const label = kind === "GIFT" ? "Accept the gift" : `Buy for ${formatDropsAsXrp(amountDrops)} XRP`;

  const accept = async () => {
    const key = unanswered.current ?? newIdempotencyKey();
    setState({ phase: "requesting" });
    try {
      const result = await callApi<PurchaseRequestResult>(`/api/offers/${offerId}/accept-intent`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key },
        body: JSON.stringify({}),
      });
      unanswered.current = null;
      setState({ phase: "approving", result });
    } catch (error) {
      unanswered.current = error instanceof ApiError && !error.responded ? key : null;
      const message = error instanceof Error ? error.message : "Could not start.";
      // Trying the same offer again can't work when the ticket went to someone else.
      const taken =
        error instanceof ApiError &&
        error.reason !== null &&
        TICKET_TAKEN_REASONS.includes(error.reason as PurchaseRefusalReason);
      setState(taken ? { phase: "gone", message } : { phase: "error", message });
    }
  };

  const settle = async (request: TransactionRequest) => {
    setState({ phase: "checking" });
    try {
      const status = await callApi<OfferStatus>(`/api/offers/${offerId}`);
      if (request.status === "CONFIRMED" && status.offer.state === "ACCEPTED") setState({ phase: "done", status });
      else if (status.offer.state === "ACTIVE") setState({ phase: "idle" });
      else {
        setState({
          phase: "gone",
          message:
            request.failureReason === "LEDGER_REJECTED"
              ? "Someone else got this ticket first, so your approval didn't go through. You paid only the small network fee."
              : GONE_MESSAGE,
        });
      }
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not check the result." });
    }
  };

  switch (state.phase) {
    case "idle":
      return (
        <button type="button" onClick={() => void accept()} className={`${primaryButton} w-full sm:w-auto`}>
          {label}
        </button>
      );
    case "requesting":
      return (
        <p role="status" className="text-sm text-muted">
          Checking the offer is still open…
        </p>
      );
    case "approving":
      return (
        <TransactionApproval
          key={state.result.request.id}
          request={state.result.request}
          title={kind === "GIFT" ? "Approve accepting the gift in Xaman" : `Approve the purchase: ${formatDropsAsXrp(amountDrops)} XRP`}
          pollIntervalMs={pollIntervalMs}
          onFinished={(request) => void settle(request)}
        />
      );
    case "checking":
      return (
        <p role="status" className="text-sm text-muted">
          Confirming on the XRP Ledger…
        </p>
      );
    case "done":
      return (
        <div role="status" className={`${notice.positive} flex flex-col gap-1`}>
          <p className="font-semibold">The ticket is now in your wallet.</p>
          <p>
            <Link href="/tickets" className="underline">
              See my tickets
            </Link>
            {" · "}
            <a href={state.status.nftExplorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
              View the ticket NFT
            </a>
            {state.status.acceptTxExplorerUrl ? (
              <>
                {" · "}
                <a href={state.status.acceptTxExplorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Transfer transaction
                </a>
              </>
            ) : null}
          </p>
        </div>
      );
    case "gone":
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className={notice.caution}>
            {state.message}
          </p>
          {otherTicketsHref ? (
            <div>
              <Link href={otherTicketsHref} className={primaryButton}>
                See other resale tickets
              </Link>
            </div>
          ) : null}
        </div>
      );
    case "error":
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className={notice.caution}>
            {state.message}
          </p>
          <div>
            <button type="button" onClick={() => void accept()} className={secondaryButton}>
              Try again
            </button>
          </div>
        </div>
      );
  }
}
