/**
 * Server wiring for the resale policy (XRPL-037). Server-only.
 *  - inventory: Agent A's `createInventoryPort()` (XRPL-020)
 *  - events: the Event table
 *  - offers: the app's offer mirror (see ./prisma-adapters.ts) until Agent B ships an OfferPort
 * Price guardrails (XRPL-095) stay off unless RESALE_MAX_MARKUP_PERCENT is set to an integer.
 */
import { getDb } from "@/lib/db/client";
import { createInventoryPort } from "@/lib/inventory/primary-inventory";
import { PrismaResaleOffers, prismaPolicyEvents } from "./prisma-adapters";
import { ResalePolicy, type ResaleGuardrails } from "./resale-policy";

const g = globalThis as unknown as { __resalePolicy?: ResalePolicy | null };

/** Reads RESALE_MAX_MARKUP_PERCENT. Unset or blank means no cap; anything else must be 0..1000. */
export function guardrailsFromEnv(env: NodeJS.ProcessEnv = process.env): ResaleGuardrails {
  const raw = env.RESALE_MAX_MARKUP_PERCENT?.trim();
  if (!raw) return {};
  if (!/^\d+$/.test(raw)) throw new Error("RESALE_MAX_MARKUP_PERCENT must be a whole number between 0 and 1000");
  return { maxMarkupPercent: Number(raw) };
}

export function getResalePolicy(): ResalePolicy {
  if (!g.__resalePolicy) {
    const db = getDb();
    g.__resalePolicy = new ResalePolicy({
      events: prismaPolicyEvents(db),
      inventory: createInventoryPort(db),
      offers: new PrismaResaleOffers(db),
      guardrails: guardrailsFromEnv(),
    });
  }
  return g.__resalePolicy;
}

/** Tests only. */
export function setResalePolicyForTests(policy: ResalePolicy | null): void {
  g.__resalePolicy = policy;
}
