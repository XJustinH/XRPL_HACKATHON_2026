import type { Drops } from "@/contracts";

/**
 * Presentation helpers for event and ticket values.
 *
 * Drops are integer strings everywhere in the contract and database; they are
 * converted to a decimal XRP string only here, at the UI edge, using BigInt so
 * no financial value passes through a float.
 */

const DROPS_PER_XRP = 1_000_000n;

/** Matches the contract's drops rule: a non-empty run of digits. */
const DROPS_PATTERN = /^[0-9]+$/;

/**
 * Formats integer drops as an XRP amount, trimming trailing zeros.
 *
 * The digit check is not redundant: `BigInt("")` is `0n`, so without it a
 * missing price would render as "0 XRP" — a free ticket — rather than as
 * unavailable.
 */
export function formatXrp(drops: Drops): string {
  if (!DROPS_PATTERN.test(drops)) return "—";
  const value = BigInt(drops);
  const whole = value / DROPS_PER_XRP;
  const fraction = value % DROPS_PER_XRP;
  if (fraction === 0n) return `${whole} XRP`;
  const fractionText = fraction.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fractionText} XRP`;
}

/** The cheapest tier price, or null when an event has no tiers yet. */
export function lowestPriceDrops(tiers: { priceDrops: Drops }[]): Drops | null {
  let lowest: bigint | null = null;
  for (const tier of tiers) {
    if (!DROPS_PATTERN.test(tier.priceDrops)) continue;
    const value = BigInt(tier.priceDrops);
    if (lowest === null || value < lowest) lowest = value;
  }
  return lowest === null ? null : lowest.toString();
}

/**
 * Formats an event date for display.
 *
 * A fixed locale and an explicit UTC timezone keep server and client output
 * identical, which avoids a hydration mismatch on a server-rendered page.
 */
export function formatEventDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

export function isPastEvent(iso: string, now = new Date()): boolean {
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.getTime() < now.getTime();
}
