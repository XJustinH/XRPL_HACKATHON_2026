/**
 * XRP formatting for display. Pure and dependency-free, so client components may
 * import it directly (`@/lib/xrpl/format`, not the `@/lib/xrpl` barrel, which is server-only).
 */

const DROPS_PER_XRP = BigInt(1_000_000);

/** "2500000" -> "2.5", "1000000" -> "1", "1" -> "0.000001". Exact integer maths, no floats. */
export function formatDropsAsXrp(drops: string | bigint): string {
  const value = typeof drops === "bigint" ? drops : BigInt(drops);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const whole = abs / DROPS_PER_XRP;
  const fraction = (abs % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
