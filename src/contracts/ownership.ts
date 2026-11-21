import type { AppId, Drops } from "./common";
import type { OfferKind, OfferState } from "./entities";
import type { TicketOwnership } from "./xrpl";

/**
 * Keeping ticket ownership in step with the XRP Ledger (XRPL-032, XRPL-043). Owner: Agent A.
 * Rules: src/lib/ownership/README.md.
 */

/** What an accepted offer was, from the app's point of view. */
export type TransferKind = "PRIMARY_SALE" | "RESALE" | "PRIVATE_SALE" | "GIFT";

/**
 * POST /api/ledger/transactions/:hash/reconcile. What reconciling one validated transaction did.
 * Calling it again for the same hash is safe and returns ALREADY_APPLIED.
 */
export type LedgerReconcileResult =
  | {
      outcome: "APPLIED";
      kind: TransferKind;
      offerId: AppId;
      ticketId: AppId | null;
      /** The account that accepted the offer: the new holder, or the broker in a brokered sale. */
      acceptedByAddress: string;
    }
  | { outcome: "ALREADY_APPLIED"; kind: TransferKind; offerId: AppId; ticketId: AppId | null }
  | {
      outcome: "NOT_APPLICABLE";
      /** NOT_AN_ACCEPT: not an NFTokenAcceptOffer. UNKNOWN_OFFER: it took no sell offer this app created. */
      reason: "NOT_AN_ACCEPT" | "UNKNOWN_OFFER";
    };

/** One of a ticket's live offers after `POST /api/tickets/:id/reconcile` brought it up to date. */
export type ReconciledOffer = {
  offerId: AppId;
  kind: OfferKind;
  ownerAddress: string;
  previousState: OfferState;
  /** STALE or EXPIRED when the ledger no longer backs it, e.g. its owner no longer holds the ticket. */
  state: OfferState;
};

/** POST /api/tickets/:id/reconcile: the ticket's verified owner, and its live offers brought up to date. */
export type TicketReconcileResult = {
  ownership: TicketOwnership;
  offers: ReconciledOffer[];
};

export type TicketHistoryKind = TransferKind | "MINT" | "OUTSIDE_APP" | "BURNED";

/**
 * One step in a ticket's history.
 * - PLATFORM: the app's mint or one of the app's offers, recorded from its validated transaction.
 * - EXTERNAL: the ticket moved outside the app. The app only saw the result on the ledger, so it
 *   can't say how or when, or how many hands it passed through.
 */
export type TicketHistoryEntry = {
  kind: TicketHistoryKind;
  source: "PLATFORM" | "EXTERNAL";
  /** Holder before; null for MINT. For OUTSIDE_APP, the last holder the app knew. */
  fromAddress: string | null;
  /** Holder after; null for BURNED. For OUTSIDE_APP, the holder the ledger showed next. */
  toAddress: string | null;
  /** Price paid for a sale; "0" for a gift; null otherwise. */
  amountDrops: Drops | null;
  /** The validated transaction; null for EXTERNAL entries. */
  txHash: string | null;
  explorerTxUrl: string | null;
  /** The transaction's ledger. For EXTERNAL entries, the validated ledger where the change was seen. */
  ledgerIndex: number | null;
  /** The transaction's ledger close time; null for EXTERNAL entries. */
  at: string | null;
};

/** GET /api/tickets/:id/history: oldest first. */
export type TicketHistory = {
  ticketId: AppId;
  nftokenId: string | null;
  entries: TicketHistoryEntry[];
  /**
   * The current holder came from a validated ledger, so anything after the last recorded step is
   * shown. False when the ledger couldn't be read: the history then ends at the last recorded step.
   */
  ownerVerified: boolean;
};
