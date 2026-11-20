"use client";

/**
 * Organiser gate scanner (XRPL-048).
 *
 * 1. Get a code: phone camera (where the browser has BarcodeDetector) or the text box,
 *    which also works with handheld scanners that type the code and press Enter.
 * 2. POST /api/checkin/verify: read-only check, shows who and what.
 * 3. Organiser taps "Admit": POST /api/checkin/confirm records the entry once.
 * Anything other than a confirmed admission is shown as "do not admit".
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CheckInResult, CheckInVerification } from "@/contracts/checkin";
import { postJson } from "@/features/onboarding/post-json";

type Verified = Extract<CheckInVerification, { status: "VERIFIED" }>;
type Admitted = Extract<CheckInResult, { status: "ADMITTED" }>;

type State =
  | { kind: "idle" }
  | { kind: "checking"; code: string; step: "verify" | "admit" }
  | { kind: "verified"; code: string; ticket: Verified }
  | { kind: "admitted"; ticket: Admitted }
  | { kind: "failed"; code: string; errorCode: string; message: string };

type Copy = { title: string; action: string; retry?: boolean };

/** Plain-language outcome for each error code. Unknown codes fall back to DEFAULT_COPY. */
export const FAILURE_COPY: Record<string, Copy> = {
  INVALID_QR: { title: "Not a valid ticket code", action: "Ask them to open the ticket in the app and show the live code." },
  UNKNOWN_TICKET: { title: "Ticket not found", action: "Do not admit. Ask them to check they opened the right ticket." },
  NOT_AUTHORISED: { title: "You can't scan for this event", action: "Only the event's organiser can admit people here." },
  WRONG_EVENT: { title: "Ticket is for a different event", action: "Do not admit." },
  EXPIRED: { title: "Code expired", action: "Ask them to refresh the code in the app, then scan again." },
  PROOF_REQUIRED: {
    title: "Not approved in wallet yet",
    action: "Ask them to approve the check-in in their wallet, then try again.",
    retry: true,
  },
  INVALID_PROOF: { title: "Wallet approval failed", action: "Do not admit. Ask them to refresh the code and approve again." },
  WRONG_OWNER: {
    title: "Ticket not held by this wallet",
    action: "It may have been sold or transferred. Do not admit.",
  },
  ALREADY_USED: { title: "Already checked in", action: "This ticket has already been used. Do not admit." },
  LEDGER_UNAVAILABLE: {
    title: "Can't confirm on the XRP Ledger right now",
    action: "Do not admit yet. Try again in a moment.",
    retry: true,
  },
  NETWORK_ERROR: { title: "No connection", action: "Check your connection and try again.", retry: true },
};
const DEFAULT_COPY: Copy = { title: "Something went wrong", action: "Do not admit. Try again.", retry: true };

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function GateScanner({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const verify = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      setState({ kind: "checking", code, step: "verify" });
      // The API answers 2xx only for VERIFIED; every failure arrives as an error envelope.
      const res = await postJson<Verified>("/api/checkin/verify", { qrPayload: code, eventId });
      if (res.ok) setState({ kind: "verified", code, ticket: res.data });
      else setState({ kind: "failed", code, errorCode: res.code, message: res.message });
    },
    [eventId],
  );

  async function admit(code: string) {
    setState({ kind: "checking", code, step: "admit" });
    const res = await postJson<Admitted>("/api/checkin/confirm", { qrPayload: code, eventId });
    if (res.ok) {
      setState({ kind: "admitted", ticket: res.data });
      router.refresh();
    } else setState({ kind: "failed", code, errorCode: res.code, message: res.message });
  }

  function reset() {
    setInput("");
    setState({ kind: "idle" });
  }

  // Keep focus where the next action is, so a handheld scanner or keyboard user never hunts for it.
  useEffect(() => {
    if (state.kind === "idle") inputRef.current?.focus();
    else if (state.kind !== "checking") primaryRef.current?.focus();
  }, [state.kind]);

  return (
    <section aria-labelledby="scan-heading" className="rounded-card border border-border bg-surface-raised p-5">
      <h2 id="scan-heading" className="text-lg font-semibold">
        Scan a ticket
      </h2>

      {state.kind === "idle" ? (
        <>
          <CameraScanner onCode={verify} />
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void verify(input);
            }}
          >
            <label htmlFor="ticket-code" className="sr-only">
              Ticket code
            </label>
            <input
              id="ticket-code"
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Scan or paste the ticket code"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-h-12 flex-1 rounded-lg border border-border bg-canvas px-3 font-mono text-sm"
            />
            <button
              type="submit"
              disabled={!input.trim()}
              className="min-h-12 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              Check ticket
            </button>
          </form>
        </>
      ) : null}

      <div aria-live="polite" className="mt-4">
        {state.kind === "checking" ? (
          <p role="status" className="rounded-lg bg-surface px-4 py-6 text-center text-sm text-muted">
            {state.step === "verify" ? "Checking ticket on the XRP Ledger…" : "Admitting…"}
          </p>
        ) : null}

        {state.kind === "verified" ? (
          <div className="rounded-lg bg-positive-soft p-4 text-positive">
            <p className="text-lg font-semibold">Valid ticket</p>
            <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm">
              <dt>Wallet</dt>
              <dd className="font-mono">{shortAddress(state.ticket.ownerAddress)}</dd>
              <dt>Ledger</dt>
              <dd>{state.ticket.ledgerIndex ?? "validated"}</dd>
            </dl>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                ref={primaryRef}
                type="button"
                onClick={() => void admit(state.code)}
                className="min-h-12 flex-1 rounded-lg bg-positive px-5 text-base font-semibold text-canvas hover:opacity-90"
              >
                Admit
              </button>
              <button
                type="button"
                onClick={reset}
                className="min-h-12 rounded-lg border border-current px-5 text-sm font-semibold"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {state.kind === "admitted" ? (
          <div className="rounded-lg bg-positive-soft p-4 text-positive">
            <p className="text-2xl font-semibold">Admitted</p>
            <p className="mt-1 text-sm">Checked in at {new Date(state.ticket.checkedInAt).toLocaleTimeString()}.</p>
            <button
              ref={primaryRef}
              type="button"
              onClick={reset}
              className="mt-4 min-h-12 w-full rounded-lg bg-accent px-5 text-base font-semibold text-accent-ink hover:opacity-90"
            >
              Scan next ticket
            </button>
          </div>
        ) : null}

        {state.kind === "failed" ? <FailurePanel state={state} onRetry={verify} onReset={reset} primaryRef={primaryRef} /> : null}
      </div>
    </section>
  );
}

function FailurePanel({
  state,
  onRetry,
  onReset,
  primaryRef,
}: {
  state: Extract<State, { kind: "failed" }>;
  onRetry: (code: string) => void;
  onReset: () => void;
  primaryRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const copy = FAILURE_COPY[state.errorCode] ?? DEFAULT_COPY;
  const tone = copy.retry ? "bg-caution-soft text-caution" : "bg-critical-soft text-critical";
  return (
    <div role="alert" className={`rounded-lg p-4 ${tone}`}>
      <p className="text-lg font-semibold">{copy.title}</p>
      <p className="mt-1 text-sm">{copy.action}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {copy.retry ? (
          <button
            ref={primaryRef}
            type="button"
            onClick={() => onRetry(state.code)}
            className="min-h-12 flex-1 rounded-lg bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            Try again
          </button>
        ) : null}
        <button
          ref={copy.retry ? undefined : primaryRef}
          type="button"
          onClick={onReset}
          className="min-h-12 flex-1 rounded-lg border border-current px-5 text-sm font-semibold"
        >
          Scan next ticket
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera (progressive enhancement: only where the browser can read QR codes itself)
// ---------------------------------------------------------------------------

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

function getDetectorCtor(): DetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

const subscribeNever = () => () => {};
const cameraScanSupported = () => getDetectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia;

function CameraScanner({ onCode }: { onCode: (code: string) => void }) {
  const supported = useSyncExternalStore(subscribeNever, cameraScanSupported, () => false);
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);


  useEffect(() => {
    if (!on) return;
    const Ctor = getDetectorCtor();
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const detector = new Ctor({ formats: ["qr_code"] });

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = s;
        await video.play();
        timer = setInterval(async () => {
          try {
            const [hit] = await detector.detect(video);
            if (hit?.rawValue && !stopped) {
              stopped = true;
              setOn(false);
              onCode(hit.rawValue);
            }
          } catch {
            // Frame not ready yet; keep scanning.
          }
        }, 250);
      })
      .catch(() => {
        setError("Camera unavailable. Allow camera access, or type the code below.");
        setOn(false);
      });

    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on, onCode]);

  if (!supported) return null;
  return (
    <div className="mt-4">
      {on ? (
        <video ref={videoRef} muted playsInline aria-label="Camera preview" className="aspect-square w-full rounded-lg bg-ink object-cover" />
      ) : null}
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOn((v) => !v);
        }}
        className="mt-2 min-h-12 w-full rounded-lg border border-border px-5 text-sm font-semibold hover:bg-surface"
      >
        {on ? "Stop camera" : "Scan with camera"}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}
