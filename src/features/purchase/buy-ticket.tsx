"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import {
  TICKET_TAKEN_REASONS,
  type OfferStatus,
  type PrimaryOfferListing,
  type PurchaseRefusalReason,
  type PurchaseRequestResult,
  type TransactionRequest,
} from "@/contracts/xrpl";
import { notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

class ApiError extends Error {
  constructor(
    message: string,
    /** False when no response arrived, so the same request may be retried with the same key. */
    readonly responded: boolean,
    /** Why the server refused, when it said (`details.reason`). */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

async function callApi<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", false);
  }
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string; details?: { reason?: unknown } | null };
  };
  if (!response.ok || body.data === undefined) {
    const reason = body.error?.details?.reason;
    throw new ApiError(
      body.error?.message ?? `Request failed (HTTP ${response.status})`,
      true,
      typeof reason === "string" ? reason : null,
    );
  }
  return body.data;
}

/** The server refused because this ticket went to, or is going to, someone else (XRPL-035). */
const ticketTaken = (error: unknown) =>
  error instanceof ApiError &&
  error.reason !== null &&
  TICKET_TAKEN_REASONS.includes(error.reason as PurchaseRefusalReason);

/** Random key for `Idempotency-Key`. getRandomValues works on plain-http LAN addresses too. */
function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type State =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "approving"; purchase: PurchaseRequestResult }
  | { phase: "checking"; purchase: PurchaseRequestResult }
  | { phase: "bought"; status: OfferStatus }
  | { phase: "unavailable"; message: string }
  | { phase: "error"; message: string; retryable: boolean };

/**
 * Buying one ticket from a primary sell offer (XRPL-031). The buyer approves an
 * `NFTokenAcceptOffer` in their own Xaman wallet; the ledger swaps the NFT and the XRP at once.
 * The purchase counts only once the ledger validated it (read back from `GET /api/offers/:id`).
 *
 * `buyerAddress` is the session's proven wallet (XRPL-012), passed by the server page; without
 * one the component asks the buyer to connect instead of failing a sale. Agent C's checkout
 * (XRPL-030) can render it for the offer the buyer picked.
 *
 * When another buyer gets the ticket first (XRPL-035), before or after this buyer's approval, it
 * says so and offers **See what's available now**. That refreshes the page, which picks the next
 * ticket on sale or says the ticket type is sold out. Render it with `key={offer.offerId}`, so the
 * next ticket starts a clean purchase.
 */
export function BuyTicket({
  offer,
  buyerAddress,
  pollIntervalMs,
}: {
  offer: PrimaryOfferListing;
  buyerAddress: string | null;
  pollIntervalMs?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle" });
  /** Key of a request that got no response, reused when the buyer tries again. */
  const unanswered = useRef<string | null>(null);
  const price = `${formatDropsAsXrp(offer.amountDrops)} XRP`;

  const buy = async () => {
    const key = unanswered.current ?? newIdempotencyKey();
    setState({ phase: "requesting" });
    try {
      const purchase = await callApi<PurchaseRequestResult>(`/api/offers/${offer.offerId}/accept-intent`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key },
        body: JSON.stringify({}),
      });
      unanswered.current = null;
      setState({ phase: "approving", purchase });
    } catch (error) {
      const responded = !(error instanceof ApiError) || error.responded;
      unanswered.current = responded ? null : key;
      const message = error instanceof Error ? error.message : "Could not start the purchase.";
      // Trying the same ticket again can't work when it went to someone else: offer another instead.
      setState(
        ticketTaken(error) ? { phase: "unavailable", message } : { phase: "error", message, retryable: true },
      );
    }
  };

  const settle = async (purchase: PurchaseRequestResult, request: TransactionRequest) => {
    setState({ phase: "checking", purchase });
    try {
      const status = await callApi<OfferStatus>(`/api/offers/${offer.offerId}`);
      if (request.status === "CONFIRMED" && status.offer.state === "ACCEPTED" && status.soldAt) {
        setState({ phase: "bought", status });
      } else if (status.offer.state === "ACTIVE" && !status.soldAt) {
        // The approval already explained what happened; the ticket is still for sale.
        setState({ phase: "error", message: "This ticket is still available.", retryable: true });
      } else {
        setState({
          phase: "unavailable",
          // The offer is closed and this buyer doesn't hold the ticket: it went elsewhere.
          message:
            request.failureReason === "LEDGER_REJECTED"
              ? "Someone else got this ticket first, so your purchase didn't go through. You paid only the small network fee, not the ticket price."
              : "This ticket went to someone else before you approved. You weren't charged.",
        });
      }
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Could not check the purchase.",
        retryable: false,
      });
    }
  };

  if (!buyerAddress) {
    return (
      <p className={notice.caution}>
        Connect your Xaman wallet to buy this ticket for {price}.{" "}
        <Link href="/connect" className="font-semibold underline">
          Connect wallet
        </Link>
      </p>
    );
  }

  switch (state.phase) {
    case "idle":
      return (
        <button type="button" onClick={() => void buy()} className={`${primaryButton} w-full sm:w-auto`}>
          Buy for {price}
        </button>
      );
    case "requesting":
      return (
        <p role="status" className="text-sm text-muted">
          Checking the ticket is still available…
        </p>
      );
    case "approving":
      return (
        <TransactionApproval
          key={state.purchase.request.id}
          request={state.purchase.request}
          title={`Approve the purchase: ${state.purchase.tierName} #${state.purchase.serial} for ${price}`}
          pollIntervalMs={pollIntervalMs}
          onFinished={(request) => void settle(state.purchase, request)}
        />
      );
    case "checking":
      return (
        <p role="status" className="text-sm text-muted">
          Confirming the purchase on the XRP Ledger…
        </p>
      );
    case "bought":
      return (
        <div role="status" className={`${notice.positive} flex flex-col gap-1`}>
          <p className="font-semibold">
            You own ticket #{state.status.serial}. It&apos;s in your wallet as an NFT.
          </p>
          <p>
            <a
              href={state.status.nftExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View the ticket NFT
            </a>
            {state.status.acceptTxExplorerUrl ? (
              <>
                {" · "}
                <a
                  href={state.status.acceptTxExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Purchase transaction
                </a>
              </>
            ) : null}
          </p>
        </div>
      );
    case "unavailable":
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className={notice.caution}>
            {state.message}
          </p>
          <div>
            {/* The page picks the next ticket on sale, or says this ticket type has sold out. */}
            <button type="button" onClick={() => router.refresh()} className={primaryButton}>
              See what&apos;s available now
            </button>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className={notice.caution}>
            {state.message}
          </p>
          {state.retryable ? (
            <div>
              <button type="button" onClick={() => void buy()} className={secondaryButton}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      );
  }
}
