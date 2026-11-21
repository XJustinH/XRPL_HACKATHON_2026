"use client";

/**
 * Check-ins per time bucket (XRPL-077): one series, so no legend; the heading names it.
 * Bars are <= 24px with a 4px rounded top and a 2px surface gap; gridlines are hairlines.
 * Every bar has a hover/focus tooltip, and "Show as table" exposes every value without hover.
 * Colours validated with the dataviz palette checks: #1d4ed8 on light, #5f88ee on dark.
 */
import { useId, useState } from "react";
import type { EventMetrics } from "@/contracts/checkin";

const W = 640;
const H = 200;
const PAD = { top: 12, right: 8, bottom: 28, left: 36 };
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;

const hhmm = (iso: string) => iso.slice(11, 16);

/** Clean y-axis: 0..max in 1, 2 or 5 x 10^n steps, at most 4 intervals. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

export function CheckInTimeline({ metrics }: { metrics: Pick<EventMetrics, "checkInTimeline" | "bucketMinutes"> }) {
  const { checkInTimeline: data, bucketMinutes } = metrics;
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();

  if (data.length === 0) {
    return <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">No check-ins yet.</p>;
  }

  const ticks = niceTicks(Math.max(...data.map((d) => d.count)));
  const top = ticks[ticks.length - 1]!;
  const band = INNER_W / data.length;
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + INNER_H - (v / top) * INNER_H;
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  const end = (i: number) => new Date(new Date(data[i]!.start).getTime() + bucketMinutes * 60_000).toISOString();
  const peak = data.reduce((best, d, i) => (d.count > data[best]!.count ? i : best), 0);

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={titleId}
        onPointerLeave={() => setActive(null)}
      >
        <title id={titleId}>
          {`Check-ins per ${bucketMinutes} minutes. Peak ${data[peak]!.count} at ${hhmm(data[peak]!.start)} UTC.`}
        </title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px]">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * band + (band - barW) / 2;
          const h = (d.count / top) * INNER_H;
          const r = Math.min(4, h, barW / 2);
          const base = PAD.top + INNER_H;
          return (
            <g key={d.start}>
              {d.count > 0 ? (
                <path
                  d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z`}
                  className={`fill-[#1d4ed8] dark:fill-[#5f88ee] ${active === i ? "opacity-80" : ""}`}
                />
              ) : null}
              {/* Hit target: the whole band, taller than the mark. */}
              <rect
                x={PAD.left + i * band}
                y={PAD.top}
                width={band}
                height={INNER_H}
                fill="transparent"
                tabIndex={0}
                // A name needs a role: without one, screen readers may ignore the label on a bare shape.
                role="img"
                aria-label={`${d.count} check-ins, ${hhmm(d.start)} to ${hhmm(end(i))} UTC`}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none focus-visible:stroke-accent focus-visible:stroke-2"
              />
              {i % labelEvery === 0 ? (
                <text x={PAD.left + i * band + band / 2} y={H - 8} textAnchor="middle" className="fill-muted text-[11px]">
                  {hhmm(d.start)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {active !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 rounded-lg border border-border bg-surface-raised px-3 py-2 text-sm shadow-sm"
          style={{ left: `${((PAD.left + (active + 0.5) * band) / W) * 100}%`, transform: "translateX(-50%)" }}
        >
          <strong className="block tabular-nums">{data[active]!.count} check-ins</strong>
          <span className="text-muted">
            {hhmm(data[active]!.start)}–{hhmm(end(active))} UTC
          </span>
        </div>
      ) : null}

      <figcaption className="mt-1 text-xs text-muted">Times in UTC, {bucketMinutes}-minute intervals.</figcaption>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted">Show as table</summary>
        <table className="mt-2 w-full max-w-xs text-left">
          <thead>
            <tr className="text-muted">
              <th scope="col" className="py-1 font-medium">From (UTC)</th>
              <th scope="col" className="py-1 text-right font-medium">Check-ins</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.start} className="border-t border-border">
                <td className="py-1">{hhmm(d.start)}</td>
                <td className="py-1 text-right tabular-nums">{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
