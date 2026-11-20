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
