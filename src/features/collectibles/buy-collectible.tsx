"use client";

import Link from "next/link";
import { useState } from "react";

import {
  NO_ENTRY_NOTICE,
  type CollectibleRequestResult,
  type CollectibleTokenView,
} from "@/contracts/collectibles";
import type { TransactionRequest } from "@/contracts/xrpl";
import { notice, primaryButton, secondaryButton } from "@/features/wallet/styles";
import { TransactionApproval } from "@/features/wallet/transaction-approval";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

import { callApi, postJson } from "./client-api";

type State =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "approving"; purchase: CollectibleRequestResult }
  | { phase: "checking" }
  | { phase: "bought"; token: CollectibleTokenView }
  | { phase: "unavailable"; message: string }
  | { phase: "error"; message: string };

/**
 * Buying one collectible edition from its sell offer (XRPL-074). The buyer approves an
 * `NFTokenAcceptOffer` in their own Xaman wallet; the ledger swaps the NFT and the XRP at once.
 * The purchase counts only once the ledger validated it, read back from
 * `GET /api/collectibles/tokens/:id`. A stale offer is refused by the server before the wallet
 * is asked, and reported here.
 *
 * `buyerAddress` is the session's proven wallet, passed by the server page.
 */
export function BuyCollectible({
  token,
  title,
  buyerAddress,
  pollIntervalMs,
}: {
  token: CollectibleTokenView;
  title: string;
  buyerAddress: string | null;
  pollIntervalMs?: number;
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const price = `${formatDropsAsXrp(token.offerAmountDrops ?? "0")} XRP`;
  const label = `${title} #${token.edition} of ${token.editionSize}`;

  const buy = async () => {
    setState({ phase: "requesting" });
    try {
      const purchase = await postJson<CollectibleRequestResult>(`/api/collectibles/tokens/${token.id}/accept-intent`);
      setState({ phase: "approving", purchase });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not start the purchase." });
    }
  };

  const settle = async (request: TransactionRequest) => {
    setState({ phase: "checking" });
    try {
      const latest = await callApi<CollectibleTokenView>(`/api/collectibles/tokens/${token.id}`);
      if (request.status === "CONFIRMED" && latest.saleStatus === "SOLD" && latest.saleTxHash === request.txHash) {
        setState({ phase: "bought", token: latest });
      } else if (latest.forSale && latest.saleStatus === "NONE") {
        // The approval already explained what happened; the edition is still for sale.
        setState({ phase: "error", message: "The purchase did not go through. This edition is still for sale." });
      } else {
        setState({
          phase: "unavailable",
          message: "This edition is no longer for sale: it was sold or its offer was withdrawn.",
        });
      }
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Could not check the purchase." });
    }
  };

  if (!buyerAddress) {
    return (
      <p className={notice.caution}>
        Connect your Xaman wallet to buy this collectible for {price}.{" "}
        <Link href="/connect" className="font-semibold underline">
          Connect wallet
        </Link>
      </p>
    );
  }

  switch (state.phase) {
    case "idle":
      return (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => void buy()} className={`${primaryButton} w-full sm:w-auto sm:self-start`}>
            Buy edition #{token.edition} for {price}
          </button>
          <p className="text-xs text-muted">{NO_ENTRY_NOTICE}</p>
        </div>
      );
    case "requesting":
      return (
        <p role="status" className="text-sm text-muted">
          Checking the offer is still on the XRP Ledger…
        </p>
      );
    case "approving":
      return (
        <TransactionApproval
          key={state.purchase.request.id}
          request={state.purchase.request}
          title={`Approve the purchase: ${label} for ${price}`}
          pollIntervalMs={pollIntervalMs}
          onFinished={(request) => void settle(request)}
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
          <p className="font-semibold">You own {label}. It&apos;s in your wallet as an NFT.</p>
          <p>
            <Link href="/collectibles" className="underline">
              See it in your collection
            </Link>
            {state.token.saleTxExplorerUrl ? (
              <>
                {" · "}
                <a href={state.token.saleTxExplorerUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  Purchase transaction
                </a>
              </>
            ) : null}
          </p>
          <p>{NO_ENTRY_NOTICE}</p>
        </div>
      );
    case "unavailable":
      return (
        <p role="alert" className={notice.caution}>
          {state.message}
        </p>
      );
    case "error":
      return (
        <div className="flex flex-col gap-2">
          <p role="alert" className={notice.caution}>
            {state.message}
          </p>
          <div>
            <button type="button" onClick={() => void buy()} className={secondaryButton}>
              Try again
            </button>
          </div>
        </div>
      );
  }
}
