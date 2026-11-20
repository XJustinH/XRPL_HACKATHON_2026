"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import type { MintStatus } from "@/contracts/entities";
import type { EventMints, MintRequestResult, MintTicketView } from "@/contracts/xrpl";
import { card, NETWORK_LABEL, notice, primaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

type EventTier = EventMints["tiers"][number];

class ApiError extends Error {
  constructor(
    message: string,
    /** False when no response arrived, so the same request may be retried with the same key. */
    readonly responded: boolean,
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
  const body = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!response.ok || body.data === undefined) {
    throw new ApiError(body.error?.message ?? `Request failed (HTTP ${response.status})`, true);
  }
  return body.data;
}

/** Random key for `Idempotency-Key`. getRandomValues works on plain-http LAN addresses too. */
function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const STATUS: Record<MintStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Awaiting approval", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "accent" },
  MINTED: { label: "Minted", tone: "positive" },
  FAILED: { label: "Not minted", tone: "caution" },
};

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-6)}`;

/**
 * Seller minting for one event (XRPL-024), shown on the event's own page: mint the next ticket
 * of a tier as a transferable NFTokenMint signed in the seller's own Xaman wallet. A ticket
 * shows as minted only after the ledger validated the transaction (the list is reloaded from
 * `GET /api/events/:id/mints`, which reconciles every mint in flight).
 *
 * - `issuerAddress` is the session's proven wallet (XRPL-012), passed by the server page. The
 *   server mints with that wallet; the browser never chooses the issuer.
 * - `tiersVersion` changes when the page's tiers change (Agent C's tier manager refreshes the
 *   page), so the list reloads without losing an approval in progress.
 */
export function MintTicketsPanel({
  eventId,
  issuerAddress,
  tiersVersion = "",
  pollIntervalMs,
}: {
  eventId: string;
  issuerAddress: string | null;
  tiersVersion?: string;
  pollIntervalMs?: number;
}) {
  return (
    <section className={card} aria-labelledby="mint-heading">
      <h2 id="mint-heading" className="text-lg font-semibold">
        Mint tickets
      </h2>
      <p className="mt-1 text-sm text-muted">
        Each ticket is a transferable NFT on {NETWORK_LABEL}. Your wallet signs the mint in Xaman and is
        recorded as the issuer. A ticket counts as minted only once the XRP Ledger has validated it.
      </p>

      {issuerAddress ? (
        <p className="mt-4 text-sm">
          Issuing wallet: <span className="font-mono break-all">{issuerAddress}</span>
        </p>
      ) : (
        <p className={`mt-4 ${notice.caution}`}>
          Connect your Xaman wallet to mint. Approving the sign-in proves the wallet is yours, and it becomes
          the issuer of the tickets you mint.{" "}
          <Link href="/connect" className="font-semibold underline">
            Connect wallet
          </Link>
        </p>
      )}

      <EventMintSection
        eventId={eventId}
        issuerAddress={issuerAddress}
        tiersVersion={tiersVersion}
        pollIntervalMs={pollIntervalMs}
      />
    </section>
  );
}

function EventMintSection({
  eventId,
  issuerAddress,
  tiersVersion,
  pollIntervalMs,
}: {
  eventId: string;
  issuerAddress: string | null;
  tiersVersion: string;
  pollIntervalMs?: number;
}) {
  const [mints, setMints] = useState<EventMints | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<{ result: MintRequestResult; tierName: string; done: boolean } | null>(
    null,
  );
  const [mintError, setMintError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Keys of mint requests that got no response, reused when the seller retries that tier. */
  const unansweredKeys = useRef(new Map<string, string>());

  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((n) => n + 1), []);

  // Load (and reconcile) the event's tickets; reloaded after each mint. Late answers are ignored.
  useEffect(() => {
    let current = true;
    callApi<EventMints>(`/api/events/${eventId}/mints`).then(
      (latest) => {
        if (!current) return;
        setMints(latest);
        setLoadError(null);
      },
      (error: unknown) => {
        if (current) setLoadError(error instanceof Error ? error.message : "Could not load tickets.");
      },
    );
    return () => {
      current = false;
    };
  }, [eventId, reloads, tiersVersion]);

  const mint = async (tier: EventTier) => {
    if (!issuerAddress) return;
    const key = unansweredKeys.current.get(tier.id) ?? newIdempotencyKey();
    setSubmitting(true);
    setMintError(null);
    try {
      const result = await callApi<MintRequestResult>(`/api/events/${eventId}/mints`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDEMPOTENCY_KEY_HEADER]: key },
        body: JSON.stringify({ tierId: tier.id }),
      });
      unansweredKeys.current.delete(tier.id);
      setActive({ result, tierName: tier.name, done: false });
      refresh();
    } catch (error) {
      if (error instanceof ApiError && !error.responded) unansweredKeys.current.set(tier.id, key);
      else unansweredKeys.current.delete(tier.id);
      setMintError(error instanceof Error ? error.message : "Could not start the mint.");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = submitting || (active !== null && !active.done);

  if (!mints) {
    return loadError ? (
      <p role="alert" className={`mt-4 ${notice.critical}`}>
        {loadError}
      </p>
    ) : (
      <p role="status" className="mt-4 text-sm text-muted">
        Loading tickets…
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      {mintError ? (
        <p role="alert" className={notice.critical}>
          {mintError}
        </p>
      ) : null}
      {loadError ? (
        <p role="alert" className={notice.caution}>
          {loadError}
        </p>
      ) : null}

      {active ? (
        <div className="flex flex-col gap-3">
          {!active.result.metadataPublic ? (
            <p className={notice.caution}>
              This app is not on a public address, so wallets and explorers cannot load this ticket&apos;s
              details yet. The mint itself works; set TICKET_METADATA_BASE_URL to the deployed URL to publish
              them.
            </p>
          ) : null}
          <TransactionApproval
            key={active.result.request.id}
            request={active.result.request}
            title={`Approve the mint: ${active.tierName} #${active.result.ticket.serial}`}
            pollIntervalMs={pollIntervalMs}
            onFinished={() => {
              setActive((current) => (current ? { ...current, done: true } : current));
              refresh();
            }}
          />
        </div>
      ) : null}

      {mints.tiers.length === 0 ? (
        <p className="text-sm text-muted">This event has no ticket tiers yet.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {mints.tiers.map((tier) => (
            <TierRow
              key={tier.id}
              tier={tier}
              canMint={issuerAddress !== null && !busy}
              onMint={() => void mint(tier)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TierRow({ tier, canMint, onMint }: { tier: EventTier; canMint: boolean; onMint: () => void }) {
  const reserved = tier.tickets.filter((t) => t.mintStatus !== "FAILED").length;
  const soldOut = reserved >= tier.totalSupply;
  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{tier.name}</h3>
          <p className="text-sm text-muted">
            {formatDropsAsXrp(tier.priceDrops)} XRP · Minted {tier.mintedQuantity} of {tier.totalSupply}
          </p>
        </div>
        <button
          type="button"
          onClick={onMint}
          disabled={!canMint || soldOut}
          className={`${primaryButton} w-full sm:w-auto`}
        >
          {soldOut ? "All tickets minted" : "Mint next ticket"}
        </button>
      </div>
      {tier.tickets.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2 text-sm" aria-label={`${tier.name} tickets`}>
          {tier.tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TicketRow({ ticket }: { ticket: MintTicketView }) {
  const status = STATUS[ticket.mintStatus];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium">#{ticket.serial}</span>
      <Badge tone={status.tone}>{status.label}</Badge>
      {ticket.nftokenId && ticket.nftExplorerUrl ? (
        <a href={ticket.nftExplorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
          NFT <span className="font-mono text-xs">{shortId(ticket.nftokenId)}</span>
        </a>
      ) : null}
      {ticket.mintTxExplorerUrl ? (
        <a href={ticket.mintTxExplorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
          Mint transaction
        </a>
      ) : null}
    </li>
  );
}
