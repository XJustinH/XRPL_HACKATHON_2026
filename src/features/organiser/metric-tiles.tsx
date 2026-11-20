import type { EventMetrics } from "@/contracts/checkin";
import { formatDropsAsXrp } from "@/lib/xrpl/format";

type Tile = { label: string; value: string; detail?: string };

export function metricTiles(m: EventMetrics): Tile[] {
  const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "–");
  return [
    { label: "Tickets sold", value: `${m.primarySold}`, detail: `of ${m.ticketsTotal} (${pct(m.primarySold, m.ticketsTotal)})` },
    { label: "Primary revenue", value: `${formatDropsAsXrp(m.primaryRevenueDrops)} XRP` },
    { label: "Resales", value: `${m.resales}`, detail: `${formatDropsAsXrp(m.resaleVolumeDrops)} XRP volume` },
    { label: "Checked in", value: `${m.checkedIn}`, detail: `${pct(m.checkedIn, m.primarySold)} of tickets sold` },
    { label: "Not checked in", value: `${m.notCheckedIn}` },
    { label: "Private transfers", value: `${m.privateTransfers}`, detail: `${m.gifts} gifts` },
  ];
}

/** Headline figures (XRPL-077). Text uses text tokens only; no colour encodes meaning. */
export function MetricTiles({ metrics }: { metrics: EventMetrics }) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {metricTiles(metrics).map((t) => (
        <div key={t.label} className="rounded-card border border-border bg-surface-raised p-4">
          <dt className="text-sm text-muted">{t.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</dd>
          {t.detail ? <dd className="text-sm text-muted">{t.detail}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * Activity not yet validated on XRPL (XRPL-076). Kept apart from the confirmed tiles and never
 * added to them, so sellers can tell confirmed sales from pending ones.
 */
export function PendingActivity({ pending }: { pending: EventMetrics["pending"] }) {
  const items = [
    { label: "Purchases awaiting confirmation", value: pending.purchases },
    { label: "Listings awaiting wallet signature", value: pending.listings },
    { label: "Tickets being minted", value: pending.mints },
  ];
  const total = items.reduce((n, i) => n + i.value, 0);
  return (
    <section aria-labelledby="pending-heading" className="mt-6 rounded-card border border-dashed border-border p-4">
      <h2 id="pending-heading" className="text-sm font-semibold">
        Waiting for the XRP Ledger
      </h2>
      <p className="text-sm text-muted">Signed or requested, but not yet validated. Not counted in the figures above.</p>
      {total === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing pending right now.</p>
      ) : (
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          {items.map((i) => (
            <div key={i.label}>
              <dt className="text-sm text-muted">{i.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{i.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
