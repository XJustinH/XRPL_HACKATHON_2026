/**
 * Storefront analytics for one seller (XRPL-078): ticket sales, physical merchandise orders and
 * digital collectible sales, each from its own records and never added together.
 *
 * - Merchandise comes from `MerchOrder` and its lines. Payment is simulated, so these are order
 *   values, not money received. Cancelled orders are reported but never counted as value.
 * - Collectible sales count only editions whose purchase was recorded from a validated tesSUCCESS
 *   NFTokenAcceptOffer (`saleStatus` SOLD). Anything still waiting is reported under `pending`.
 * - Ticket figures follow the per-event analytics (XRPL-076): validated primary sales only.
 *
 * XRP amounts are summed as integer drops (BigInt), never floats. Each section also reports how its
 * total reconciles with the records behind it.
 */
import type {
  CollectibleMetrics,
  CollectibleSaleLine,
  LedgerSaleCheck,
  MerchandiseMetrics,
  StorefrontMetrics,
  TicketSalesSummary,
} from "@/contracts/analytics";
import { MerchOrderStatus } from "@/contracts/commerce";
import type { PrismaClient } from "@/generated/prisma/client";
import type { XrplConfig } from "@/lib/xrpl/config";
import { isXrplServiceError } from "@/lib/xrpl/errors";
import { explorerTxUrl } from "@/lib/xrpl/explorer";
import type { XrplQueryService } from "@/lib/xrpl/query";

type Db = Pick<PrismaClient, "merchOrder" | "collectible" | "collectibleToken" | "event" | "ticketNFT" | "nFTOffer">;
type ExplorerConfig = Pick<XrplConfig, "explorerUrl" | "networkLabel">;

/** How many sales the summary lists. The totals always cover every sale. */
export const MAX_SALES_LISTED = 50;
/** How many listed sales one page view reads again from the ledger. */
export const MAX_SALES_CHECKED = 10;

const ZERO = BigInt(0);
const sumDrops = (values: readonly string[]) => values.reduce((total, value) => total + BigInt(value), ZERO);

export async function getStorefrontMetrics(
  db: Db,
  sellerId: string,
  config: ExplorerConfig,
  now = new Date(),
): Promise<StorefrontMetrics> {
  const [tickets, merchandise, collectibles] = await Promise.all([
    ticketSummary(db, sellerId),
    merchandiseMetrics(db, sellerId),
    collectibleMetrics(db, sellerId, config),
  ]);
  return { sellerId, tickets, merchandise, collectibles, calculatedAt: now.toISOString() };
}

async function ticketSummary(db: Db, sellerId: string): Promise<TicketSalesSummary> {
  const [events, sold, offers] = await Promise.all([
    db.event.count({ where: { sellerId } }),
    db.ticketNFT.count({ where: { event: { sellerId }, primarySoldAt: { not: null } } }),
    db.nFTOffer.findMany({
      where: { ticket: { event: { sellerId } }, kind: "PRIMARY", state: "ACCEPTED" },
      select: { amountDrops: true },
    }),
  ]);
  return {
    currency: "XRP",
    settlement: "XRPL",
    events,
    sold,
    revenueDrops: sumDrops(offers.map((offer) => offer.amountDrops)).toString(),
  };
}

async function merchandiseMetrics(db: Db, sellerId: string): Promise<MerchandiseMetrics> {
  const orders = await db.merchOrder.findMany({
    where: { sellerId },
    select: { id: true, status: true, totalDrops: true, items: { select: { unitPriceDrops: true, quantity: true } } },
  });

  const lines = new Map(MerchOrderStatus.options.map((status) => [status, { orders: 0, units: 0, total: ZERO }]));
  let orderTotals = ZERO;
  let lineTotals = ZERO;
  const mismatchedOrderIds: string[] = [];
  for (const order of orders) {
    const stored = BigInt(order.totalDrops);
    const fromLines = order.items.reduce(
      (total, item) => total + BigInt(item.unitPriceDrops) * BigInt(item.quantity),
      ZERO,
    );
    const line = lines.get(order.status);
    if (line) {
      line.orders += 1;
      line.units += order.items.reduce((units, item) => units + item.quantity, 0);
      line.total += stored;
    }
    orderTotals += stored;
    lineTotals += fromLines;
    if (stored !== fromLines) mismatchedOrderIds.push(order.id);
  }

  const byStatus = MerchOrderStatus.options.map((status) => {
    const line = lines.get(status) ?? { orders: 0, units: 0, total: ZERO };
    return { status, orders: line.orders, units: line.units, totalDrops: line.total.toString() };
  });
  const counted = byStatus.filter((line) => line.status !== "CANCELLED");
  const cancelled = byStatus.find((line) => line.status === "CANCELLED");
  return {
    currency: "XRP",
    settlement: "SIMULATED",
    orders: orders.length,
    byStatus,
    ordersCounted: counted.reduce((n, line) => n + line.orders, 0),
    unitsSold: counted.reduce((n, line) => n + line.units, 0),
    orderValueDrops: sumDrops(counted.map((line) => line.totalDrops)).toString(),
    cancelledDrops: cancelled?.totalDrops ?? "0",
    reconciliation: {
      orderTotalsDrops: orderTotals.toString(),
      lineTotalsDrops: lineTotals.toString(),
      mismatchedOrderIds,
      reconciled: mismatchedOrderIds.length === 0,
    },
  };
}

async function collectibleMetrics(db: Db, sellerId: string, config: ExplorerConfig): Promise<CollectibleMetrics> {
  const published = { sellerId, status: "PUBLISHED" as const };
  const [listings, tokens] = await Promise.all([
    db.collectible.count({ where: published }),
    db.collectibleToken.findMany({
      where: { collectible: published },
      select: {
        id: true,
        collectibleId: true,
        edition: true,
        nftokenId: true,
        mintStatus: true,
        offerStatus: true,
        offerIndex: true,
        offerAmountDrops: true,
        saleStatus: true,
        saleTxHash: true,
        soldAt: true,
        collectible: { select: { title: true, editionSize: true } },
      },
    }),
  ]);

  const sold = tokens
    .filter((token) => token.saleStatus === "SOLD")
    .sort((a, b) => (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0));
  // A sale is backed by the ledger when it carries the validated purchase's hash and its amount.
  const backed = sold.filter((token) => token.saleTxHash !== null && token.offerAmountDrops !== null);
  const revenue = sumDrops(sold.map((token) => token.offerAmountDrops ?? "0"));
  const backedRevenue = sumDrops(backed.map((token) => token.offerAmountDrops ?? "0"));

  const sales: CollectibleSaleLine[] = sold.slice(0, MAX_SALES_LISTED).map((token) => ({
    tokenId: token.id,
    collectibleId: token.collectibleId,
    title: token.collectible.title,
    edition: token.edition,
    editionSize: token.collectible.editionSize,
    nftokenId: token.nftokenId,
    amountDrops: token.offerAmountDrops ?? "0",
    soldAt: token.soldAt ? token.soldAt.toISOString() : null,
    txHash: token.saleTxHash,
    explorerUrl: token.saleTxHash ? explorerTxUrl(config, token.saleTxHash) : null,
  }));

  const count = (test: (token: (typeof tokens)[number]) => boolean) => tokens.filter(test).length;
  return {
    currency: "XRP",
    settlement: "XRPL",
    networkLabel: config.networkLabel,
    listings,
    editions: tokens.length,
    minted: count((t) => t.mintStatus === "MINTED"),
    forSale: count((t) => t.offerStatus === "ACTIVE" && t.saleStatus === "NONE" && t.offerIndex !== null),
    sold: sold.length,
    revenueDrops: revenue.toString(),
    pending: {
      mints: count((t) => t.mintStatus === "PENDING" || t.mintStatus === "SUBMITTED"),
      listings: count((t) => t.offerStatus === "PENDING"),
      purchases: count((t) => t.saleStatus === "PENDING"),
    },
    notCompleted: {
      failedMints: count((t) => t.mintStatus === "FAILED"),
      failedListings: count((t) => t.offerStatus === "FAILED"),
      staleOffers: count((t) => t.offerStatus === "STALE"),
    },
    reconciliation: {
      salesWithTransaction: backed.length,
      salesWithTransactionDrops: backedRevenue.toString(),
      reconciled: backed.length === sold.length,
    },
    sales,
    salesTruncated: sold.length > sales.length,
  };
}

/**
 * Reads the most recent listed sales again from the ledger. A sale is VALIDATED only when its
 * transaction is in a validated ledger with tesSUCCESS, is an NFTokenAcceptOffer and moved this
 * edition's NFT. MISMATCH only when the ledger contradicts the record. A ledger that can't be
 * reached, or a node that no longer keeps the transaction, gives UNAVAILABLE, never a guess.
 */
export async function checkSalesOnLedger(
  ledger: Pick<XrplQueryService, "getValidatedTx">,
  sales: readonly Pick<CollectibleSaleLine, "txHash" | "nftokenId">[],
): Promise<LedgerSaleCheck[]> {
  const checkable = sales.filter((sale): sale is { txHash: string; nftokenId: string | null } => sale.txHash !== null);
  return Promise.all(
    checkable.slice(0, MAX_SALES_CHECKED).map(async ({ txHash, nftokenId }): Promise<LedgerSaleCheck> => {
      try {
        const tx = await ledger.getValidatedTx(txHash);
        const matches = tx.transactionType === "NFTokenAcceptOffer" && nftokenId !== null && tx.nftokenId === nftokenId;
        return { txHash, outcome: matches ? "VALIDATED" : "MISMATCH", ledgerIndex: tx.ledgerIndex };
      } catch (error) {
        // Validated with a failure result contradicts the record. Not found is not proof: public
        // nodes keep limited history, so an old transaction can be missing from the node asked.
        const contradicted = isXrplServiceError(error) && error.code === "TX_FAILED";
        return { txHash, outcome: contradicted ? "MISMATCH" : "UNAVAILABLE", ledgerIndex: null };
      }
    }),
  );
}
