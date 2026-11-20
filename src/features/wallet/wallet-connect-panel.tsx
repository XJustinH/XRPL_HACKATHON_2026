"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import type { WalletReadiness } from "@/contracts/events";
import type { SignRequest } from "@/contracts/xrpl";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { card, NETWORK_LABEL, primaryButton, secondaryButton } from "./styles";
import { TestTransactionCheck } from "./test-transaction-check";
import { useSignIn, type SignInState } from "./use-sign-in";
import {
  clearConnectedWallet,
  saveConnectedWallet,
  useConnectedWallet,
  type ConnectedWallet,
} from "./wallet-store";

const NETWORK_NAMES: Record<string, string> = {
  MAINNET: "XRPL Mainnet",
  TESTNET: "XRPL Testnet",
  DEVNET: "XRPL Devnet",
};

/**
 * Connect / disconnect an XRPL wallet through Xaman (XRPL-011). The user approves a
 * sign-in request in their own Xaman app; the app only ever sees the public address.
 * `testTransactions` adds the developer approval check (XRPL-014); the page passes
 * the server's setting.
 */
export function WalletConnectPanel({
  pollIntervalMs,
  testTransactions = false,
}: {
  pollIntervalMs?: number;
  testTransactions?: boolean;
}) {
  const wallet = useConnectedWallet();
  const onConnected = useCallback((request: SignRequest & { account: string }) => {
    saveConnectedWallet({
      address: request.account,
      network: request.walletNetwork ?? "",
      connectedAt: new Date().toISOString(),
    });
  }, []);
  const { state, start, cancel, reset } = useSignIn({ onConnected, pollIntervalMs });

  if (wallet) {
    return (
      <ConnectedWalletCard
        wallet={wallet}
        testTransactions={testTransactions}
        pollIntervalMs={pollIntervalMs}
        onDisconnect={() => {
          clearConnectedWallet();
          reset();
        }}
      />
    );
  }
  return <ConnectCard state={state} onStart={() => void start()} onCancel={() => void cancel()} />;
}

function outcomeOf(state: SignInState): { tone: "caution" | "critical"; text: string } | null {
  if (state.phase === "error") return { tone: "critical", text: state.message };
  if (state.phase !== "finished") return null;
  const { request } = state;
  switch (request.status) {
    case "SIGNED": {
      const signedOn = NETWORK_NAMES[request.walletNetwork ?? ""] ?? "a different network";
      return {
        tone: "critical",
        text: `Your Xaman app signed on ${signedOn}, but this app uses ${NETWORK_LABEL}. Switch the network in Xaman's settings, then try again.`,
      };
    }
    case "REJECTED":
      return { tone: "caution", text: "You declined the request in Xaman, so nothing was shared." };
    case "EXPIRED":
      return { tone: "caution", text: "The request expired before it was approved. Start a new one." };
    case "CANCELLED":
      return { tone: "caution", text: "Request cancelled." };
    default:
      return null;
  }
}

function ConnectCard({
  state,
  onStart,
  onCancel,
}: {
  state: SignInState;
  onStart: () => void;
  onCancel: () => void;
}) {
  if (state.phase === "waiting") {
    const { request } = state;
    return (
      <section className={card} aria-labelledby="wallet-request-heading">
        <h2 id="wallet-request-heading" className="text-base font-semibold">
          Approve the sign-in in Xaman
        </h2>
        <p role="status" className="mt-1 text-sm text-muted">
          {request.status === "OPENED"
            ? "Request opened in Xaman. Review and approve it there."
            : "Scan the QR code with Xaman, or open the request on this device."}
        </p>
        <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          {/* eslint-disable-next-line @next/next/no-img-element -- Xaman serves this QR image; next/image would need a remote pattern in next.config. */}
          <img
            src={request.qrPngUrl}
            alt="QR code for the Xaman sign-in request"
            width={200}
            height={200}
            className="rounded-lg border border-border bg-white p-2"
          />
          <div className="flex w-full flex-col gap-3 text-sm sm:w-auto">
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
            <button type="button" onClick={onCancel} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  const outcome = outcomeOf(state);
  return (
    <section className={card} aria-labelledby="wallet-connect-heading">
      <h2 id="wallet-connect-heading" className="text-base font-semibold">
        Connect with Xaman
      </h2>
      <p className="mt-1 text-sm text-muted">
        You approve a sign-in request in the Xaman app. It shows which account is yours and does not move any
        funds. This platform never asks for your seed phrase or private key.
      </p>
      {outcome ? (
        <p
          role="alert"
          className={`mt-4 rounded-lg px-3 py-2 text-sm ${
            outcome.tone === "critical" ? "bg-critical-soft text-critical" : "bg-caution-soft text-caution"
          }`}
        >
          {outcome.text}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onStart}
        disabled={state.phase === "starting"}
        className={`${primaryButton} mt-4`}
      >
        {state.phase === "starting" ? "Preparing request…" : outcome ? "Try again" : "Connect with Xaman"}
      </button>
    </section>
  );
}

function ConnectedWalletCard({
  wallet,
  testTransactions,
  pollIntervalMs,
  onDisconnect,
}: {
  wallet: ConnectedWallet;
  testTransactions: boolean;
  pollIntervalMs?: number;
  onDisconnect: () => void;
}) {
  return (
    <section className={card} aria-labelledby="wallet-connected-heading">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="wallet-connected-heading" className="text-base font-semibold">
          Wallet connected
        </h2>
        <Badge tone="positive">{NETWORK_LABEL}</Badge>
      </div>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Public address</p>
      <p className="mt-1 break-all font-mono text-sm">{wallet.address}</p>
      <WalletReadinessSummary key={wallet.address} address={wallet.address} />
      <div className="mt-5">
        <button type="button" onClick={onDisconnect} className={secondaryButton}>
          Disconnect
        </button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Disconnecting forgets this wallet in this browser. Your wallet and funds are not affected.
      </p>
      {testTransactions ? (
        <TestTransactionCheck key={wallet.address} address={wallet.address} pollIntervalMs={pollIntervalMs} />
      ) : null}
    </section>
  );
}

function WalletReadinessSummary({ address }: { address: string }) {
  const [readiness, setReadiness] = useState<WalletReadiness | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/wallet/readiness?address=${encodeURIComponent(address)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { data?: WalletReadiness };
        if (!response.ok || !body.data) throw new Error(`HTTP ${response.status}`);
        return body.data;
      })
      .then((data) => active && setReadiness(data))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [address]);

  if (failed) return <p className="mt-4 text-sm text-muted">Balance unavailable right now.</p>;
  if (!readiness) return <p className="mt-4 text-sm text-muted">Checking balance…</p>;
  return (
    <div className="mt-4 text-sm">
      {readiness.balanceDrops !== null ? (
        <p>
          <span className="font-semibold">{formatDropsAsXrp(readiness.balanceDrops)} XRP</span>{" "}
          <span className="text-muted">spendable</span>
        </p>
      ) : null}
      {readiness.blockers.length > 0 ? (
        <ul className="mt-2 space-y-1 text-caution">
          {readiness.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
