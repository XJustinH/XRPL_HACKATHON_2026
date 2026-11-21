import type { MerchOrderStatus } from "./commerce";
import type { IsoDateTime } from "./common";

/**
 * Storefront analytics (XRPL-078): one seller's ticket sales, physical merchandise orders and
 * digital collectible sales, always reported separately. They are never added together: tickets and
 * collectibles settle on the XRP Ledger, merchandise payment is simulated.
 * Safe to import from client code. Not re-exported from `./index`; import this file directly.
 */

/** Ticket sales across all of the seller's events. Per-event detail is on each event's analytics. */
export type TicketSalesSummary = {
  currency: "XRP";
  /** Counted only from validated XRPL transactions. */
  settlement: "XRPL";
  events: number;
  /** Validated primary sales. */
  sold: number;
  /** Sum of accepted primary offers, integer drops. */
  revenueDrops: string;
};

export type MerchStatusLine = {
  status: MerchOrderStatus;
  orders: number;
  units: number;
  /** Sum of those orders' totals, integer drops. */
  totalDrops: string;
};

/** Physical merchandise orders (XRPL-067 to XRPL-069). */
export type MerchandiseMetrics = {
  /** Prices are XRP, stored as integer drops. */
  currency: "XRP";
  /** Payment is simulated in this build: no money moved and nothing settled on the ledger. */
  settlement: "SIMULATED";
  /** Every order placed with this seller, cancelled ones included. */
  orders: number;
  /** One line per order status in lifecycle order, including statuses with no orders. */
  byStatus: MerchStatusLine[];
  /** Orders that were not cancelled. */
  ordersCounted: number;
  /** Units in those orders. */
  unitsSold: number;
  /** Sum of those orders' totals. Cancelled orders are never included. */
  orderValueDrops: string;
  /** Sum of cancelled orders' totals. */
  cancelledDrops: string;
  /** The totals checked against the order records they come from. */
  reconciliation: {
    /** Sum of the stored total of every order. */
    orderTotalsDrops: string;
    /** Sum of unit price x quantity over every order line. */
    lineTotalsDrops: string;
    /** Orders whose stored total differs from the sum of their own lines. Empty when reconciled. */
    mismatchedOrderIds: string[];
    reconciled: boolean;
  };
};

/** One counted collectible sale and the validated transaction it was recorded from. */
export type CollectibleSaleLine = {
  tokenId: string;
  collectibleId: string;
  title: string;
  edition: number;
  editionSize: number;
  nftokenId: string | null;
  amountDrops: string;
  soldAt: IsoDateTime | null;
  /** Hash of the validated NFTokenAcceptOffer. */
  txHash: string | null;
  explorerUrl: string | null;
};

/** Digital collectible NFT sales (XRPL-073, XRPL-074). */
export type CollectibleMetrics = {
  currency: "XRP";
  /** Sales are XRP Ledger transactions; only validated ones are counted. */
  settlement: "XRPL";
  /** Which network the transactions are on, e.g. "XRPL Testnet". */
  networkLabel: string;
  /** Published collectibles. */
  listings: number;
  /** Editions across them. */
  editions: number;
  /** Editions with a validated mint. */
  minted: number;
  /** Editions with a live sell offer that nobody has bought. */
  forSale: number;
  /** Editions with a validated purchase. */
  sold: number;
  /** Sum of the sell-offer amounts of sold editions, integer drops. */
  revenueDrops: string;
  /** Requested or signed but not yet validated. Never part of the figures above. */
  pending: { mints: number; listings: number; purchases: number };
  /** Last attempt failed, or the sell offer is no longer on the ledger. Nothing was sold. */
  notCompleted: { failedMints: number; failedListings: number; staleOffers: number };
  /** The totals checked against the ledger records they come from. */
  reconciliation: {
    /** Sold editions that carry the hash of their validated purchase and its amount. */
    salesWithTransaction: number;
    /** Sum over those editions. Equals `revenueDrops` when every sale has its transaction. */
    salesWithTransactionDrops: string;
    reconciled: boolean;
  };
  /** The counted sales, newest first. Capped; `salesTruncated` says when older ones are left out. */
  sales: CollectibleSaleLine[];
  salesTruncated: boolean;
};

/** GET /api/sellers/me/analytics */
export type StorefrontMetrics = {
  sellerId: string;
  tickets: TicketSalesSummary;
  merchandise: MerchandiseMetrics;
  collectibles: CollectibleMetrics;
  calculatedAt: IsoDateTime;
};

/**
 * One collectible sale read again from the ledger. VALIDATED: the transaction is in a validated
 * ledger with tesSUCCESS and moved this NFT. MISMATCH: the ledger contradicts the record.
 * UNAVAILABLE: the ledger could not be read, or the node asked no longer keeps the transaction,
 * so nothing is claimed either way.
 */
export type LedgerSaleCheck = {
  txHash: string;
  outcome: "VALIDATED" | "MISMATCH" | "UNAVAILABLE";
  ledgerIndex: number | null;
};
