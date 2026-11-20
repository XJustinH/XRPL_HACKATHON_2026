"use client";

/**
 * Attendee side of check-in (XRPL-044/045).
 *
 *  1. "Show check-in code" -> POST /api/checkin/challenges with the wallet connected in this browser.
 *  2. POST .../sign-request -> approve in Xaman (button on phones, Xaman QR on desktop).
 *  3. Poll GET /api/wallet/sign-requests/:id until final; when SIGNED, POST .../prove.
 *  4. Show the gate QR with a countdown. The code only works after step 3.
 *
 * Built as a standalone component so Agent C can place it on the ticket page (XRPL-034).
 */
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import type { CheckInApprovalStarted, CheckInChallengeIssued } from "@/contracts/checkin";
import type { SignRequest } from "@/contracts/xrpl";
import { postJson } from "@/features/onboarding/post-json";
import { useConnectedWallet } from "@/features/wallet/wallet-store";
import { FAILURE_COPY } from "./gate-scanner";

type State =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "approve"; code: CheckInChallengeIssued; approval: CheckInApprovalStarted }
  | { kind: "ready"; code: CheckInChallengeIssued; qrDataUrl: string }
  | { kind: "error"; title: string; detail: string };

const WALLET_DECLINED: Record<string, string> = {
  REJECTED: "You declined the request in Xaman.",
  EXPIRED: "The Xaman request expired before it was approved.",
  CANCELLED: "The Xaman request was cancelled.",
  WRONG_NETWORK: "Xaman signed on a different network. Switch Xaman to XRPL Testnet and try again.",
};

export function CheckInCodePanel({ ticketId, pollIntervalMs = 2000 }: { ticketId: string; pollIntervalMs?: number }) {
  const wallet = useConnectedWallet();
  const [state, setState] = useState<State>({ kind: "idle" });
  const run = useRef(0); // invalidates in-flight polling when the user starts over

  async function start() {
    if (!wallet) return;
    const id = ++run.current;
    setState({ kind: "working", label: "Creating your check-in code…" });
    const issued = await postJson<CheckInChallengeIssued>("/api/checkin/challenges", { ticketId, walletAddress: wallet.address });
    if (!issued.ok) return id === run.current && setState(errorState(issued.code, issued.message));

    const approval = await postJson<CheckInApprovalStarted>(`/api/checkin/challenges/${issued.data.challengeId}/sign-request`, {});
    if (!approval.ok) return id === run.current && setState(errorState(approval.code, approval.message));
    if (id !== run.current) return;
    setState({ kind: "approve", code: issued.data, approval: approval.data });

    const outcome = await waitForSignature(approval.data.signRequest.id, pollIntervalMs, () => id !== run.current);
    if (id !== run.current) return;
    if (outcome !== "SIGNED") {
      return setState({ kind: "error", title: "Check-in not approved", detail: WALLET_DECLINED[outcome] ?? "Couldn't confirm the approval." });
    }

    setState({ kind: "working", label: "Confirming your approval…" });
    const proved = await postJson(`/api/checkin/challenges/${issued.data.challengeId}/prove`, { proof: approval.data.proof });
    if (id !== run.current) return;
    if (!proved.ok) return setState(errorState(proved.code, proved.message));

    const qrDataUrl = await QRCode.toDataURL(issued.data.qrPayload, { errorCorrectionLevel: "M", margin: 2, width: 320 });
    if (id === run.current) setState({ kind: "ready", code: issued.data, qrDataUrl });
  }

  function startOver() {
    run.current += 1;
    setState({ kind: "idle" });
  }

  useEffect(() => () => void (run.current += 1), []);

  if (!wallet) {
    return (
      <Panel>
        <p className="text-sm text-muted">Connect the wallet that holds this ticket to get a check-in code.</p>
        <Link href="/connect" className={primaryButton + " mt-4 inline-flex items-center justify-center"}>
          Connect wallet
        </Link>
      </Panel>
    );
  }

  return (
    <Panel>
      <div aria-live="polite">
        {state.kind === "idle" ? (
          <>
            <p className="text-sm text-muted">
              Show this at the door. You&apos;ll approve it in Xaman first, so a screenshot of someone else&apos;s code
              won&apos;t work.
            </p>
            <button type="button" onClick={() => void start()} className={primaryButton + " mt-4 w-full"}>
              Show check-in code
            </button>
          </>
        ) : null}

        {state.kind === "working" ? (
          <p role="status" className="rounded-lg bg-surface px-4 py-6 text-center text-sm text-muted">
            {state.label}
          </p>
        ) : null}

        {state.kind === "approve" ? <ApproveStep approval={state.approval.signRequest} onCancel={startOver} /> : null}

        {state.kind === "ready" ? <ReadyStep code={state.code} qrDataUrl={state.qrDataUrl} onExpired={startOver} /> : null}

        {state.kind === "error" ? (
          <div role="alert" className="rounded-lg bg-critical-soft p-4 text-critical">
            <p className="font-semibold">{state.title}</p>
            <p className="mt-1 text-sm">{state.detail}</p>
            <button type="button" onClick={() => void start()} className={secondaryButton + " mt-4 w-full"}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function ApproveStep({ approval, onCancel }: { approval: SignRequest; onCancel: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="font-semibold">Approve check-in in Xaman</p>
      <p className="text-sm text-muted">This proves the ticket is in your wallet. It moves no funds.</p>
      <a href={approval.signUrl} target="_blank" rel="noreferrer" className={primaryButton + " w-full"}>
        Open in Xaman
      </a>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote QR image served by Xaman */}
      <img src={approval.qrPngUrl} alt="Xaman approval QR code" width={180} height={180} className="hidden rounded-lg sm:block" />
      <p role="status" className="text-sm text-muted">
        Waiting for approval…
      </p>
      <button type="button" onClick={onCancel} className={secondaryButton + " w-full"}>
        Cancel
      </button>
    </div>
  );
}

function ReadyStep({ code, qrDataUrl, onExpired }: { code: CheckInChallengeIssued; qrDataUrl: string; onExpired: () => void }) {
  const secondsLeft = useSecondsUntil(code.expiresAt);
  if (secondsLeft <= 0) {
    return (
      <div role="alert" className="rounded-lg bg-caution-soft p-4 text-caution">
        <p className="font-semibold">Code expired</p>
        <button type="button" onClick={onExpired} className={secondaryButton + " mt-4 w-full"}>
          Get a new code
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-lg font-semibold text-positive">Ready: show this at the door</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- generated data URL */}
      <img src={qrDataUrl} alt="Check-in QR code" width={280} height={280} className="rounded-lg bg-white p-2" />
      <p className="text-sm text-muted tabular-nums">
        Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Polls Agent B's sign-request status until it is final. */
async function waitForSignature(id: string, intervalMs: number, cancelled: () => boolean): Promise<string> {
  for (;;) {
    if (cancelled()) return "CANCELLED";
    try {
      const res = await fetch(`/api/wallet/sign-requests/${id}`, { cache: "no-store", credentials: "same-origin" });
      if (res.ok) {
        const { data } = (await res.json()) as { data: SignRequest };
        if (data.status === "SIGNED") return data.networkMatches === false ? "WRONG_NETWORK" : "SIGNED";
        if (data.status === "REJECTED" || data.status === "EXPIRED" || data.status === "CANCELLED") return data.status;
      }
    } catch {
      // Network blip: keep polling until the request expires.
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function useSecondsUntil(iso: string): number {
  const target = new Date(iso).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((target - now) / 1000));
}

function errorState(code: string, message: string): State {
  const copy = FAILURE_COPY[code];
  if (code === "WALLET_NOT_VERIFIED") return { kind: "error", title: "Wallet needed", detail: message };
  if (code === "WRONG_OWNER") return { kind: "error", title: "This wallet doesn't hold the ticket", detail: message };
  return { kind: "error", title: copy?.title ?? "Something went wrong", detail: message };
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="checkin-code-heading" className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id="checkin-code-heading" className="mb-3 text-lg font-semibold">
        Check-in code
      </h2>
      {children}
    </section>
  );
}

const primaryButton = "min-h-12 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-ink hover:opacity-90";
const secondaryButton = "min-h-12 rounded-lg border border-current px-5 py-3 text-sm font-semibold";
