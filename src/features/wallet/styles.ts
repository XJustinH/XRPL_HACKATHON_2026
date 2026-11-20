/** Shared class names for wallet UI, built on Agent C's design tokens (src/app/globals.css). */

export const NETWORK_LABEL = process.env.NEXT_PUBLIC_XRPL_NETWORK_LABEL ?? "XRPL Testnet";

export const card = "rounded-card border border-border bg-surface-raised p-5";

export const primaryButton =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButton =
  "inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60";

export const notice = {
  caution: "rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution",
  critical: "rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical",
  positive: "rounded-lg bg-positive-soft px-3 py-2 text-sm text-positive",
} as const;
