"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";

import { RESALE_LIMITATION_NOTICE } from "@/contracts/checkin";
import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import type { OfferStatus, TicketOfferRequestResult, TransactionRequest } from "@/contracts/xrpl";
import { xrpToDrops } from "@/features/events/event-formatting";
import { card, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { ApiError, callApi, newIdempotencyKey, shortAddress, XRPL_ADDRESS_PATTERN } from "./api";

export type TransferKind = "RESALE" | "PRIVATE" | "GIFT";

/** A live offer the holder already made for this ticket. */
export type OpenOffer = {
  id: string;
  kind: TransferKind | "PRIMARY";
  state: "PENDING_SIGNATURE" | "ACTIVE";
  amountDrops: string;
  destinationAddress: string | null;
};

const MODES: { kind: TransferKind; label: string; route: string }[] = [
  { kind: "RESALE", label: "Sell", route: "resale-offers" },
  { kind: "PRIVATE", label: "Sell to a friend", route: "private-offers" },
  { kind: "GIFT", label: "Gift", route: "gift-offers" },
];

type State =
  | { phase: "form" }
  | { phase: "confirmGift"; destination: string }
  | { phase: "requesting" }
  | { phase: "approving"; result: TicketOfferRequestResult }
  | { phase: "checking" }
  | { phase: "open"; offer: OpenOffer }
  | { phase: "error"; message: string };

/**
 * The holder's ways to pass a ticket on (XRPL-036 resale, 040 private sale, 041 gift). Each creates an
 * NFT sell offer the holder approves in Xaman; nothing moves until the other side accepts it.
 * A gift asks for confirmation first, because once the recipient accepts it can't be undone.
 */
export function TicketTransferPanel({
  ticketId,
  holderAddress,
  openOffer,
  pollIntervalMs,
}: {
  ticketId: string;
  holderAddress: string;
  openOffer: OpenOffer | null;
  pollIntervalMs?: number;
}) {
  const [kind, setKind] = useState<TransferKind>("RESALE");
  const [price, setPrice] = useState("");
  const [destination, setDestination] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [state, setState] = useState<State>(openOffer ? { phase: "open", offer: openOffer } : { phase: "form" });
  /** Key of a request that got no response, reused when the holder tries again. */
  const unanswered = useRef<string | null>(null);
  const ids = useId();

  const mode = MODES.find((m) => m.kind === kind)!;
  const needsPrice = kind !== "GIFT";
  const needsRecipient = kind !== "RESALE";

  /** Validates the form; returns the request body, or null after showing why not. */
  const readForm = (): Record<string, string> | null => {
    const body: Record<string, string> = {};
    if (needsRecipient) {
      const address = destination.trim();
      if (!XRPL_ADDRESS_PATTERN.test(address)) return fail("Enter your friend's XRPL address (it starts with r)");
      if (address === holderAddress) return fail("That's your own wallet. Enter your friend's address");
      body.destination = address;
    }
    if (needsPrice) {
      const parsed = xrpToDrops(price);
      if (!parsed.ok) return fail(parsed.message);
      if (parsed.drops === "0") return fail("Set a price above 0 XRP, or choose Gift to give it away");
      body.amountDrops = parsed.drops;
    }
    setFieldError(null);
    return body;
  };
  const fail = (message: string) => {
    setFieldError(message);
    return null;
  };

  const create = async (body: Record<string, string>) => {
    const key = unanswered.current ?? newIdempotencyKey();
    setState({ phase: "requesting" });
    try {
      const result = await callApi<TicketOfferRequestResult>(`/api/tickets/${ticketId}/${mode.route}`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key },
        body: JSON.stringify(body),
      });
      unanswered.current = null;
      setState({ phase: "approving", result });
    } catch (error) {
      unanswered.current = error instanceof ApiError && !error.responded ? key : null;
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not create the offer." });
    }
  };

  const submit = () => {
    const body = readForm();
    if (!body) return;
    if (kind === "GIFT") setState({ phase: "confirmGift", destination: body.destination as string });
    else void create(body);
  };

  const settle = async (result: TicketOfferRequestResult, request: TransactionRequest) => {
    setState({ phase: "checking" });
    try {
      const status = await callApi<OfferStatus>(`/api/offers/${result.offer.id}`);
      if (request.status === "CONFIRMED" && status.offer.state === "ACTIVE") {
        setState({
          phase: "open",
          offer: {
            id: status.offer.id,
            kind: status.offer.kind,
            state: "ACTIVE",
            amountDrops: status.offer.amountDrops,
            destinationAddress: status.offer.destinationAddress,
          },
        });
      } else {
        setState({ phase: "form" });
      }
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not check the offer." });
    }
  };

  return (
    <section aria-labelledby={`${ids}-heading`} className={card}>
      <h2 id={`${ids}-heading`} className="text-lg font-semibold">
        Pass this ticket on
      </h2>
      {state.phase === "open" ? (
        <OpenOfferView offer={state.offer} />
      ) : state.phase === "approving" ? (
        <div className="mt-3">
          <TransactionApproval
            key={state.result.request.id}
            request={state.result.request}
            title={approvalTitle(state.result.offer.kind, state.result.offer.amountDrops)}
            pollIntervalMs={pollIntervalMs}
            onFinished={(request) => void settle(state.result, request)}
          />
        </div>
      ) : state.phase === "requesting" || state.phase === "checking" ? (
        <p role="status" className="mt-3 text-sm text-muted">
          {state.phase === "requesting" ? "Checking you still hold this ticket…" : "Confirming the offer on the XRP Ledger…"}
        </p>
      ) : state.phase === "confirmGift" ? (
        <div className="mt-3 flex flex-col gap-3" role="alertdialog" aria-labelledby={`${ids}-confirm`}>
          <p id={`${ids}-confirm`} className={notice.caution}>
            You&apos;re giving this ticket to <span className="font-mono">{shortAddress(state.destination)}</span> for
            free. Once they accept it, the ticket is theirs and this can&apos;t be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={() => void create({ destination: state.destination })}>
              Yes, create the gift
            </button>
            <button type="button" className={secondaryButton} onClick={() => setState({ phase: "form" })}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div role="group" aria-label="How to pass it on" className="flex flex-wrap gap-2">
            {MODES.map((m) => (
              <button
                key={m.kind}
                type="button"
                aria-pressed={kind === m.kind}
                onClick={() => {
                  setKind(m.kind);
                  setFieldError(null);
                }}
                className={kind === m.kind ? primaryButton : secondaryButton}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted">{describe(kind)}</p>

          {needsRecipient ? (
            <div>
              <label htmlFor={`${ids}-destination`} className="block text-sm font-medium">
                Friend&apos;s XRPL address
              </label>
              <input
                id={`${ids}-destination`}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="r…"
                className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 font-mono text-sm"
              />
            </div>
          ) : null}
          {needsPrice ? (
            <div>
              <label htmlFor={`${ids}-price`} className="block text-sm font-medium">
                Price in XRP
              </label>
              <input
                id={`${ids}-price`}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="decimal"
                placeholder="2.5"
                className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm sm:w-48"
              />
            </div>
          ) : null}

          {fieldError ? (
            <p role="alert" className={notice.critical}>
              {fieldError}
            </p>
          ) : null}
          {state.phase === "error" ? (
            <p role="alert" className={notice.caution}>
              {state.message}
            </p>
          ) : null}
          <div>
            <button type="submit" className={primaryButton}>
              {kind === "RESALE" ? "List for sale" : kind === "PRIVATE" ? "Create private sale" : "Gift ticket"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function describe(kind: TransferKind): string {
  switch (kind) {
    case "RESALE":
      return `Anyone can buy it at your price. ${RESALE_LIMITATION_NOTICE}`;
    case "PRIVATE":
      return "Only your friend's wallet can buy it, at the price you set. Nothing moves until they accept.";
    case "GIFT":
      return "Give it to your friend for free. Only their wallet can accept it.";
  }
}

function approvalTitle(kind: string, amountDrops: string): string {
  if (kind === "GIFT") return "Approve the gift in Xaman";
  return `Approve the offer in Xaman: ${formatDropsAsXrp(amountDrops)} XRP`;
}

/** An offer the holder already made: what it is, and the link to send the other person. */
function OpenOfferView({ offer }: { offer: OpenOffer }) {
  const path = `/offers/${offer.id}`;
  const [copied, setCopied] = useState(false);
  const price = `${formatDropsAsXrp(offer.amountDrops)} XRP`;

  if (offer.state === "PENDING_SIGNATURE") {
    return (
      <p role="status" className="mt-3 text-sm text-muted">
        An offer for this ticket is waiting for your approval in Xaman. Approve or decline it there.
      </p>
    );
  }

  const summary =
    offer.kind === "GIFT"
      ? `Gift ready for ${shortAddress(offer.destinationAddress ?? "")}.`
      : offer.kind === "PRIVATE"
        ? `Private sale ready for ${shortAddress(offer.destinationAddress ?? "")} at ${price}.`
        : `Listed for resale at ${price}.`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div role="status" className="mt-3 flex flex-col gap-2">
      <p className={notice.positive}>{summary} Nothing moves until it&apos;s accepted.</p>
      {offer.kind === "RESALE" ? (
        <p className="text-sm text-muted">{RESALE_LIMITATION_NOTICE}</p>
      ) : (
        <p className="text-sm">Send your friend this link. They accept it with the wallet you named.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={path} className="text-sm font-medium text-accent underline">
          {offer.kind === "RESALE" ? "View the listing" : "Open the offer link"}
        </Link>
        <button type="button" className={secondaryButton} onClick={() => void copy()}>
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
    </div>
  );
}
