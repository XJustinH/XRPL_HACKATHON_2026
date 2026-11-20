"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { IDEMPOTENCY_KEY_HEADER } from "@/contracts/common";
import type { MintStatus } from "@/contracts/entities";
import type {
  EventMints,
  MintMappingReport,
  MintRequestResult,
  MintTicketView,
  TransactionRequest,
} from "@/contracts/xrpl";
import { card, NETWORK_LABEL, notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
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

/**
 * A minting run (XRPL-025): mint `target` tickets of one tier, one Xaman approval at a time.
 * Bounded three ways: it never asks for more than the tier's remaining quantity (the server
 * also refuses to reserve beyond supply), it stops at the first ticket that is not confirmed,
 * and step `index` sends `Idempotency-Key: <key>-<index>`, so retrying a step whose answer
 * was lost replays it instead of reserving another ticket.
 */
interface MintRun {
  tierId: string;
  tierName: string;
  target: number;
  minted: number;
  key: string;
  index: number;
  current: MintRequestResult | null;
  phase: "requesting" | "approving" | "paused" | "finished" | "stopped";
  message: string | null;
  stopRequested: boolean;
}

const isRunning = (run: MintRun | null) => run?.phase === "requesting" || run?.phase === "approving";

function stopReason(request: TransactionRequest): string {
  switch (request.status) {
    case "REJECTED":
      return "You declined the last ticket in Xaman, so minting stopped.";
    case "EXPIRED":
      return "The last request expired before it was approved, so minting stopped.";
    case "CANCELLED":
      return "You cancelled the last request, so minting stopped.";
    default:
      return `The last mint did not go through (${request.engineResult ?? request.failureReason ?? "unknown reason"}), so minting stopped.`;
  }
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
  const [run, setRunState] = useState<MintRun | null>(null);
  // The run's source of truth for async callbacks; `run` mirrors it for rendering.
  const runRef = useRef<MintRun | null>(null);
  const setRun = useCallback((next: MintRun | null) => {
    runRef.current = next;
    setRunState(next);
  }, []);

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

  const requestStep = useCallback(
    async (step: MintRun) => {
      setRun({ ...step, phase: "requesting", current: null, message: null });
      try {
        const result = await callApi<MintRequestResult>(`/api/events/${eventId}/mints`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [IDEMPOTENCY_KEY_HEADER]: `${step.key}-${step.index}`,
          },
          body: JSON.stringify({ tierId: step.tierId }),
        });
        setRun({ ...(runRef.current ?? step), current: result, phase: "approving" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not start the mint.";
        // No answer: the same step may be retried with the same key. An answer: stop here.
        const paused = error instanceof ApiError && !error.responded;
        setRun({ ...(runRef.current ?? step), phase: paused ? "paused" : "stopped", message });
      } finally {
        refresh();
      }
    },
    [eventId, refresh, setRun],
  );

  const startRun = (tier: EventTier, count: number) => {
    if (!issuerAddress || count < 1 || isRunning(runRef.current)) return;
    void requestStep({
      tierId: tier.id,
      tierName: tier.name,
      target: count,
      minted: 0,
      key: newIdempotencyKey(),
      index: 0,
      current: null,
      phase: "requesting",
      message: null,
      stopRequested: false,
    });
  };

  const onStepFinished = (request: TransactionRequest) => {
    const step = runRef.current;
    refresh();
    if (!step || step.current?.request.id !== request.id) return;
    if (request.status !== "CONFIRMED") {
      setRun({ ...step, phase: "stopped", message: stopReason(request) });
      return;
    }
    const minted = step.minted + 1;
    if (minted >= step.target) {
      setRun({ ...step, minted, phase: "finished", message: null });
    } else if (step.stopRequested) {
      setRun({
        ...step,
        minted,
        phase: "stopped",
        message: `Stopped after ${minted} of ${step.target}, as asked.`,
      });
    } else {
      void requestStep({ ...step, minted, index: step.index + 1 });
    }
  };

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

  const busy = isRunning(run);
  return (
    <div className="mt-4 flex flex-col gap-4">
      {loadError ? (
        <p role="alert" className={notice.caution}>
          {loadError}
        </p>
      ) : null}

      {run ? (
        <MintRunProgress
          run={run}
          pollIntervalMs={pollIntervalMs}
          onStepFinished={onStepFinished}
          onStop={() => {
            const step = runRef.current;
            if (step) setRun({ ...step, stopRequested: true });
          }}
          onRetry={() => {
            const step = runRef.current;
            if (step) void requestStep(step);
          }}
          onDismiss={() => setRun(null)}
        />
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
              onMint={(count) => startRun(tier, count)}
            />
          ))}
        </ul>
      )}

      <LedgerCheck eventId={eventId} onRecorded={refresh} />
    </div>
  );
}

/** Progress of a minting run: how many are minted, the current approval, and why it stopped. */
function MintRunProgress({
  run,
  pollIntervalMs,
  onStepFinished,
  onStop,
  onRetry,
  onDismiss,
}: {
  run: MintRun;
  pollIntervalMs?: number;
  onStepFinished: (request: TransactionRequest) => void;
  onStop: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const ticketNumber = Math.min(run.minted + 1, run.target);
  return (
    <section
      aria-label="Minting progress"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Minting {run.tierName}</h3>
        <p className="text-sm text-muted">
          {run.minted} of {run.target} minted
        </p>
      </div>
      <progress
        className="h-2 w-full"
        value={run.minted}
        max={run.target}
        aria-label={`${run.minted} of ${run.target} tickets minted`}
      />

      {run.phase === "requesting" ? (
        <p role="status" className="text-sm text-muted">
          Preparing ticket {ticketNumber} of {run.target}…
        </p>
      ) : null}

      {run.phase === "approving" && run.current ? (
        <>
          {!run.current.metadataPublic ? (
            <p className={notice.caution}>
              This app is not on a public address, so wallets and explorers cannot load this ticket&apos;s
              details yet. The mint itself works; set TICKET_METADATA_BASE_URL to the deployed URL to publish
              them.
            </p>
          ) : null}
          <TransactionApproval
            key={run.current.request.id}
            request={run.current.request}
            title={`Approve the mint: ${run.tierName} #${run.current.ticket.serial} (${ticketNumber} of ${run.target})`}
            pollIntervalMs={pollIntervalMs}
            onFinished={onStepFinished}
          />
          {run.target > 1 && run.minted + 1 < run.target ? (
            <div>
              <button type="button" onClick={onStop} disabled={run.stopRequested} className={secondaryButton}>
                {run.stopRequested ? "Stopping after this ticket" : "Stop after this ticket"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {run.phase === "finished" ? (
        <p role="status" className={notice.positive}>
          Minted {plural(run.minted, "ticket")} of {run.tierName} on {NETWORK_LABEL}.
        </p>
      ) : null}
      {run.phase === "paused" || run.phase === "stopped" ? (
        <p role="alert" className={run.phase === "paused" ? notice.caution : notice.critical}>
          {run.message}
        </p>
      ) : null}

      {run.phase === "paused" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRetry} className={primaryButton}>
            Try again
          </button>
          <button type="button" onClick={onDismiss} className={secondaryButton}>
            Stop
          </button>
        </div>
      ) : null}
      {run.phase === "finished" || run.phase === "stopped" ? (
        <div>
          <button type="button" onClick={onDismiss} className={secondaryButton}>
            Done
          </button>
        </div>
      ) : null}
    </section>
  );
}

type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; report: MintMappingReport }
  | { phase: "error"; message: string };

/** XRPL-026: compare the event's tickets with the ledger and record mints the app missed. */
function LedgerCheck({ eventId, onRecorded }: { eventId: string; onRecorded: () => void }) {
  const [state, setState] = useState<CheckState>({ phase: "idle" });

  const check = async () => {
    setState({ phase: "checking" });
    try {
      const report = await callApi<MintMappingReport>(`/api/events/${eventId}/mints/reconcile`, {
        method: "POST",
      });
      setState({ phase: "done", report });
      if (report.recorded.length > 0) onRecorded();
    } catch (error) {
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : "Could not check the ledger.",
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Compare every ticket with the XRP Ledger, and record any mint the app missed.
        </p>
        <button
          type="button"
          onClick={() => void check()}
          disabled={state.phase === "checking"}
          className={`${secondaryButton} w-full sm:w-auto`}
        >
          {state.phase === "checking" ? "Checking…" : "Check against the ledger"}
        </button>
      </div>
      {state.phase === "error" ? (
        <p role="alert" className={notice.critical}>
          {state.message}
        </p>
      ) : null}
      {state.phase === "done" ? <LedgerCheckResult report={state.report} /> : null}
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function LedgerCheckResult({ report }: { report: MintMappingReport }) {
  const recorded = report.recorded.length;
  const summary = [
    report.verified === 0
      ? "No minted tickets to compare yet."
      : `${plural(report.verified, "minted ticket")} ${report.verified === 1 ? "matches" : "match"} the XRP Ledger.`,
    recorded > 0 ? `Recorded ${plural(recorded, "mint")} found on the ledger.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div role="status" className="flex flex-col gap-2">
      {report.issues.length === 0 ? (
        <p className={notice.positive}>{summary}</p>
      ) : (
        <div className={notice.critical}>
          <p className="font-semibold">
            {plural(report.issues.length, "problem")} found. Nothing was changed for{" "}
            {report.issues.length === 1 ? "it" : "them"}.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {report.issues.map((issue, index) => (
              <li key={`${issue.problem}-${issue.txHash ?? issue.ticketId ?? index}`} className="break-words">
                {issue.serial ? `#${issue.serial}: ` : ""}
                {issue.detail}
              </li>
            ))}
          </ul>
          <p className="mt-1">{summary}</p>
        </div>
      )}
      {!report.complete ? (
        <p className={notice.caution}>
          This wallet has a long history, so only its most recent transactions were read. Older mints were not
          checked.
        </p>
      ) : null}
    </div>
  );
}

/** Separate counts of a tier's minted, pending and failed tickets, and what is left to mint. */
function tierProgress(tier: EventTier) {
  const minted = tier.tickets.filter((t) => t.mintStatus === "MINTED");
  const pending = tier.tickets.filter((t) => t.mintStatus === "PENDING" || t.mintStatus === "SUBMITTED");
  const failed = tier.tickets.filter((t) => t.mintStatus === "FAILED");
  // Failed tickets never produced an NFT and are reused, so they are still left to mint.
  const remaining = Math.max(tier.totalSupply - minted.length - pending.length, 0);
  return { minted, pending, failed, remaining };
}

function TierRow({
  tier,
  canMint,
  onMint,
}: {
  tier: EventTier;
  canMint: boolean;
  onMint: (count: number) => void;
}) {
  const { minted, pending, failed, remaining } = tierProgress(tier);
  const groups = [
    { label: "Minted", tickets: minted },
    { label: "Pending", tickets: pending },
    { label: "Failed", tickets: failed },
  ].filter((group) => group.tickets.length > 0);

  return (
    <li className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{tier.name}</h3>
          <p className="text-sm text-muted">
            {formatDropsAsXrp(tier.priceDrops)} XRP · Minted {tier.mintedQuantity} of {tier.totalSupply}
          </p>
          <p className="text-sm text-muted">
            {minted.length} minted · {pending.length} pending · {failed.length} failed
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          {remaining === 0 ? (
            <button type="button" disabled className={`${primaryButton} w-full sm:w-auto`}>
              {pending.length > 0 ? "Waiting on pending mints" : "All tickets minted"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onMint(1)}
                disabled={!canMint}
                className={`${remaining > 1 ? secondaryButton : primaryButton} w-full sm:w-auto`}
              >
                Mint next ticket
              </button>
              {remaining > 1 ? (
                <button
                  type="button"
                  onClick={() => onMint(remaining)}
                  disabled={!canMint}
                  className={`${primaryButton} w-full sm:w-auto`}
                >
                  Mint all {remaining} remaining
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
      {groups.map((group) => (
        <details key={group.label} open={group.tickets.length <= 8} className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">
            {group.label} ({group.tickets.length})
          </summary>
          <ul
            className="mt-2 flex flex-col gap-2 text-sm"
            aria-label={`${tier.name}: ${group.label.toLowerCase()} tickets`}
          >
            {group.tickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} />
            ))}
          </ul>
        </details>
      ))}
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
