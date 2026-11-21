import Link from "next/link";

import type {
  CollectibleMetrics,
  LedgerSaleCheck,
  MerchandiseMetrics,
  TicketSalesSummary,
} from "@/contracts/analytics";
import { MERCH_ORDER_STATUS_LABELS } from "@/contracts/commerce";
import { Badge } from "@/components/ui/badge";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

/**
 * Presentational sections of the storefront analytics page (XRPL-078). No hooks and no data
 * loading. Each section names its currency and how its sales settle, because the three are not
 * comparable: tickets and collectibles are validated XRP Ledger transactions, merchandise payment
 * is simulated. Text carries every meaning; colour is never the only signal.
 */

const xrp = (drops: string) => `${formatDropsAsXrp(drops)} XRP`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const section = "mt-8 rounded-card border border-border bg-surface-raised p-5";
const cell = "px-2 py-2 text-left align-top sm:px-3";

type Tile = { label: string; value: string; detail?: string };

function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-card border border-border bg-surface p-4">
          <dt className="text-sm text-muted">{tile.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</dd>
          {tile.detail ? <dd className="text-sm text-muted">{tile.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function SectionHeading({ id, title, badges }: { id: string; title: string; badges: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {badges.map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
    </div>
  );
}

/** Whether a section's total agrees with the records behind it, in words. */
function Reconciliation({ reconciled, children }: { reconciled: boolean; children: React.ReactNode }) {
  return reconciled ? (
    <p className="mt-4 text-sm text-muted">
      <span className="font-medium text-ink">Reconciled.</span> {children}
    </p>
  ) : (
    <p role="alert" className="mt-4 rounded-card bg-critical-soft px-4 py-3 text-sm text-critical">
      <span className="font-semibold">Does not reconcile.</span> {children}
    </p>
  );
}

export function ticketTiles(tickets: TicketSalesSummary): Tile[] {
  return [
    { label: "Events", value: `${tickets.events}` },
    { label: "Tickets sold", value: `${tickets.sold}`, detail: "validated primary sales" },
    { label: "Ticket revenue", value: xrp(tickets.revenueDrops), detail: "primary sales only" },
  ];
}

export function TicketSummarySection({ tickets }: { tickets: TicketSalesSummary }) {
  return (
    <section aria-labelledby="tickets-heading" className={section}>
      <SectionHeading id="tickets-heading" title="Tickets" badges={["XRP", "Validated on the XRP Ledger"]} />
      <p className="mt-1 text-sm text-muted">
        Across all your events. Resales, check-ins and anything still waiting are on each event&apos;s own analytics.
      </p>
      <Tiles tiles={ticketTiles(tickets)} />
      <p className="mt-4 text-sm">
        <Link href="/seller/events" className="font-medium text-accent underline">
          Open an event&apos;s analytics
        </Link>
      </p>
    </section>
  );
}

export function merchandiseTiles(merchandise: MerchandiseMetrics): Tile[] {
  return [
    { label: "Orders", value: `${merchandise.ordersCounted}`, detail: "not cancelled" },
    { label: "Units ordered", value: `${merchandise.unitsSold}` },
    { label: "Order value", value: xrp(merchandise.orderValueDrops), detail: "simulated payment" },
    {
      label: "Cancelled",
      value: `${merchandise.orders - merchandise.ordersCounted}`,
      detail: `${xrp(merchandise.cancelledDrops)}, not counted`,
    },
  ];
}

export function MerchandiseSection({ merchandise }: { merchandise: MerchandiseMetrics }) {
  const { reconciliation } = merchandise;
  return (
    <section aria-labelledby="merchandise-heading" className={section}>
      <SectionHeading id="merchandise-heading" title="Physical merchandise" badges={["XRP", "Simulated payment"]} />
      <p className="mt-1 text-sm text-muted">
        Orders for your physical products. Payment is simulated in this build, so these are order values: no money has
        moved and nothing here is an XRP Ledger transaction.
      </p>
      <Tiles tiles={merchandiseTiles(merchandise)} />

      {/* Four short columns: narrow enough for a phone, so it never needs to scroll sideways. */}
      <div className="mt-4">
        <table className="w-full text-sm">
          <caption className="sr-only">Merchandise orders by fulfilment status</caption>
          <thead className="border-b border-border text-muted">
            <tr>
              <th scope="col" className={cell}>
                Order status
              </th>
              <th scope="col" className={cell}>
                Orders
              </th>
              <th scope="col" className={cell}>
                Units
              </th>
              <th scope="col" className={cell}>
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {merchandise.byStatus.map((line) => (
              <tr key={line.status} className="border-b border-border last:border-0">
                <th scope="row" className={`${cell} font-medium`}>
                  {MERCH_ORDER_STATUS_LABELS[line.status]}
                  {line.status === "CANCELLED" ? <span className="font-normal text-muted"> (not counted)</span> : null}
                </th>
                <td className={`${cell} tabular-nums`}>{line.orders}</td>
                <td className={`${cell} tabular-nums`}>{line.units}</td>
                <td className={`${cell} tabular-nums`}>{xrp(line.totalDrops)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Reconciliation reconciled={reconciliation.reconciled}>
        {reconciliation.reconciled ? (
          merchandise.orders === 0 ? (
            <>There are no orders to check yet.</>
          ) : merchandise.orders === 1 ? (
            <>The order&apos;s total is {xrp(reconciliation.orderTotalsDrops)}, the same as the sum of its order lines.</>
          ) : (
            <>
              The totals of all {merchandise.orders} orders come to {xrp(reconciliation.orderTotalsDrops)}, the same as
              the sum of their order lines.
            </>
          )
        ) : (
          <>
            Order totals come to {xrp(reconciliation.orderTotalsDrops)} but their order lines add up to{" "}
            {xrp(reconciliation.lineTotalsDrops)}. Check {plural(reconciliation.mismatchedOrderIds.length, "order")}:{" "}
            {reconciliation.mismatchedOrderIds.join(", ")}.
          </>
        )}{" "}
        <Link href="/seller/products" className="font-medium text-accent underline">
          See the orders
        </Link>
      </Reconciliation>
    </section>
  );
}

export function collectibleTiles(collectibles: CollectibleMetrics): Tile[] {
  return [
    { label: "Editions sold", value: `${collectibles.sold}`, detail: `of ${collectibles.minted} minted` },
    { label: "Collectible revenue", value: xrp(collectibles.revenueDrops), detail: "validated sales only" },
    { label: "For sale now", value: `${collectibles.forSale}` },
    {
      label: "Minted",
      value: `${collectibles.minted}`,
      detail: `of ${plural(collectibles.editions, "edition")} in ${plural(collectibles.listings, "listing")}`,
    },
  ];
}

/** What the ledger said when a listed sale was read again. */
export function ledgerCheckText(check: LedgerSaleCheck | undefined): string {
  if (!check) return "Recorded from a validated transaction";
  if (check.outcome === "VALIDATED") {
    return check.ledgerIndex === null ? "Checked on the ledger" : `Checked on the ledger (ledger ${check.ledgerIndex})`;
  }
  if (check.outcome === "MISMATCH") return "The ledger does not match this record";
  return "Recorded as validated; the ledger could not be read again just now";
}

function CollectiblePending({ collectibles }: { collectibles: CollectibleMetrics }) {
  const { pending, notCompleted } = collectibles;
  const waiting = [
    { label: "Purchases awaiting confirmation", value: pending.purchases },
    { label: "Listings awaiting wallet signature", value: pending.listings },
    { label: "Editions being minted", value: pending.mints },
  ];
  const stopped = [
    { label: "failed mint", value: notCompleted.failedMints },
    { label: "failed listing", value: notCompleted.failedListings },
    { label: "sell offer no longer on the ledger", many: "sell offers no longer on the ledger", value: notCompleted.staleOffers },
  ].filter((item) => item.value > 0);
  return (
    <div className="mt-4 rounded-card border border-dashed border-border p-4">
      <h3 className="text-sm font-semibold">Waiting for the XRP Ledger</h3>
      <p className="text-sm text-muted">Signed or requested, but not yet validated. Not counted in the figures above.</p>
      {waiting.every((item) => item.value === 0) ? (
        <p className="mt-2 text-sm text-muted">Nothing pending right now.</p>
      ) : (
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          {waiting.map((item) => (
            <div key={item.label}>
              <dt className="text-sm text-muted">{item.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {stopped.length > 0 ? (
        <p className="mt-3 text-sm text-muted">
          Not completed, and not counted: {stopped.map((item) => plural(item.value, item.label, item.many)).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

export function CollectiblesSection({
  collectibles,
  checks,
}: {
  collectibles: CollectibleMetrics;
  /** Results of reading the most recent sales again from the ledger, if that was done. */
  checks: LedgerSaleCheck[];
}) {
  const { reconciliation, sales } = collectibles;
  const checkFor = new Map(checks.map((check) => [check.txHash, check]));
  const contradicted = checks.filter((check) => check.outcome === "MISMATCH").length;
  return (
    <section aria-labelledby="collectibles-heading" className={section}>
      <SectionHeading
        id="collectibles-heading"
        title="Digital collectibles"
        badges={["XRP", `Validated on ${collectibles.networkLabel}`]}
      />
      <p className="mt-1 text-sm text-muted">
        NFT sales of your published collectibles. A sale is counted only once its purchase transaction is validated on
        the XRP Ledger. Resales between collectors are not included.
      </p>
      <Tiles tiles={collectibleTiles(collectibles)} />
      <CollectiblePending collectibles={collectibles} />

      <h3 id="collectible-sales-heading" className="mt-6 text-sm font-semibold">
        Sales behind this total
      </h3>
      {sales.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No collectible has been sold yet.</p>
      ) : (
        /*
         * A list, not a table: four columns do not fit a phone, and a table that scrolls sideways
         * hides the transaction, which is the point of this section.
         */
        <ul aria-labelledby="collectible-sales-heading" className="mt-2 divide-y divide-border text-sm">
          {sales.map((sale) => (
            <li key={sale.tokenId} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="min-w-0 font-medium">
                  <Link href={`/collectibles/${sale.collectibleId}`} className="hover:underline">
                    {sale.title}
                  </Link>{" "}
                  <span className="font-normal text-muted">
                    #{sale.edition} of {sale.editionSize}
                  </span>
                </p>
                <p className="tabular-nums">{xrp(sale.amountDrops)}</p>
              </div>
              <p className="mt-1 text-muted">
                {sale.soldAt ? `Sold ${sale.soldAt.slice(0, 16).replace("T", " ")} UTC` : "Sale time not recorded"}
              </p>
              {sale.txHash && sale.explorerUrl ? (
                <>
                  <a
                    href={sale.explorerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 inline-flex min-h-6 items-center font-mono text-accent underline"
                  >
                    {/* Said before the hash, so the link makes sense out of context and keeps its visible text in its name. */}
                    <span className="sr-only">Purchase transaction</span>{" "}
                    {sale.txHash.slice(0, 8)}…{sale.txHash.slice(-6)}
                  </a>
                  <p className="text-muted">{ledgerCheckText(checkFor.get(sale.txHash))}</p>
                </>
              ) : (
                <p className="mt-1 text-critical">No transaction recorded</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {collectibles.salesTruncated ? (
        <p className="mt-2 text-sm text-muted">
          Showing the {sales.length} most recent of {collectibles.sold} sales. The totals cover all of them.
        </p>
      ) : null}

      <Reconciliation reconciled={reconciliation.reconciled && contradicted === 0}>
        {!reconciliation.reconciled ? (
          <>
            {plural(collectibles.sold - reconciliation.salesWithTransaction, "sale")} of {collectibles.sold} have no
            validated transaction recorded. Sales with one come to {xrp(reconciliation.salesWithTransactionDrops)} of the{" "}
            {xrp(collectibles.revenueDrops)} shown.
          </>
        ) : contradicted > 0 ? (
          <>
            The ledger does not match {plural(contradicted, "recorded sale")}. See the transactions marked above.
          </>
        ) : (
          collectibles.sold === 0 ? (
            <>There are no sales to check yet.</>
          ) : collectibles.sold === 1 ? (
            <>
              The sale carries the hash of a validated purchase transaction, for{" "}
              {xrp(reconciliation.salesWithTransactionDrops)}.
            </>
          ) : (
            <>
              All {collectibles.sold} sales carry the hash of a validated purchase transaction, and their amounts come
              to {xrp(reconciliation.salesWithTransactionDrops)}.
            </>
          )
        )}
      </Reconciliation>
    </section>
  );
}
