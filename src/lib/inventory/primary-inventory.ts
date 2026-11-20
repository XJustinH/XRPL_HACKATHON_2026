import type { PrismaClient } from "@/generated/prisma/client";
import type { EventAvailability, PrimaryAvailability, TierAvailability } from "@/contracts";
import type { InventoryPort } from "@/features/integration/ports";
import { getDb } from "@/lib/db/client";

/**
 * Primary inventory and sell-out state (XRPL-020). Owner: Agent A.
 *
 * The app-side trigger for opening resale. All figures come from records written only after a
 * validated XRPL transaction, never from client claims:
 *  - sold      = MINTED tickets with `primarySoldAt` (set from a validated primary sale, XRPL-032)
 *  - remaining = totalSupply - sold. Unminted or failed-mint supply and pending purchases stay here.
 *  - pending   = unsold MINTED tickets with an `NFTokenAcceptOffer` LedgerTransaction still PENDING
 *  - from      = cheapest ACTIVE primary offer on an unsold ticket. Expired, cancelled, failed
 *                and stale offers are ignored and their tickets stay unsold.
 *  - sold out  = the event has supply and every unit of every tier has a validated sale.
 *
 * Inventory is app-side: a transfer made outside the app is caught by reconciliation
 * (XRPL-032/043), not here.
 */

type Db = Pick<PrismaClient, "ticketTier" | "ticketNFT" | "nFTOffer" | "ledgerTransaction">;

export type TierFacts = {
  tierId: string;
  name: string;
  priceDrops: string;
  totalSupply: number;
  /** Validated primary sales in this tier. */
  sold: number;
  /** Unsold minted tickets with a purchase in flight. */
  pending: number;
  /** `amountDrops` of ACTIVE primary offers on unsold minted tickets. */
  activeAsks: string[];
};

// ---------------------------------------------------------------------------
// Rules (pure)
// ---------------------------------------------------------------------------

/** Smallest drops amount, compared as integers (never floats), or null for none. */
export function minDrops(values: readonly (string | null)[]): string | null {
  let min: bigint | null = null;
  for (const v of values) {
    if (v === null) continue;
    const n = BigInt(v);
    if (min === null || n < min) min = n;
  }
  return min === null ? null : min.toString();
}

export function summariseTier(f: TierFacts): TierAvailability {
  const totalSupply = Math.max(0, f.totalSupply);
  const sold = Math.min(Math.max(0, f.sold), totalSupply);
  const remaining = totalSupply - sold;
  return {
    tierId: f.tierId,
    name: f.name,
    priceDrops: f.priceDrops,
    totalSupply,
    sold,
    remaining,
    pending: Math.min(Math.max(0, f.pending), remaining),
    fromPriceDrops: remaining > 0 ? minDrops(f.activeAsks) : null,
  };
}

export function summariseEvent(eventId: string, tiers: TierAvailability[], now: Date): PrimaryAvailability {
  const sum = (k: "totalSupply" | "sold" | "remaining" | "pending") => tiers.reduce((n, t) => n + t[k], 0);
  const totalSupply = sum("totalSupply");
  const remaining = sum("remaining");
  return {
    eventId,
    totalSupply,
    sold: sum("sold"),
    remaining,
    pending: sum("pending"),
    isSoldOut: tiers.length > 0 && totalSupply > 0 && remaining === 0,
    fromPriceDrops: minDrops(tiers.map((t) => t.fromPriceDrops)),
    calculatedAt: now.toISOString(),
    tiers,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const countByTier = (rows: { tierId: string }[]) => {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.tierId, (counts.get(r.tierId) ?? 0) + 1);
  return counts;
};

/** Availability for several events at once (e.g. a listing page). Unknown events read as empty. */
export async function getPrimaryAvailabilityMany(
  db: Db,
  eventIds: readonly string[],
  now = new Date(),
): Promise<Map<string, PrimaryAvailability>> {
  const ids = [...new Set(eventIds)];
  const result = new Map<string, PrimaryAvailability>();
  if (ids.length === 0) return result;

  const [tiers, sold, unsoldMinted, asks] = await Promise.all([
    db.ticketTier.findMany({
      where: { eventId: { in: ids } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, eventId: true, name: true, priceDrops: true, totalSupply: true },
    }),
    db.ticketNFT.findMany({
      where: { eventId: { in: ids }, mintStatus: "MINTED", primarySoldAt: { not: null } },
      select: { tierId: true },
    }),
    db.ticketNFT.findMany({
      where: { eventId: { in: ids }, mintStatus: "MINTED", primarySoldAt: null },
      select: { id: true, tierId: true },
    }),
    db.nFTOffer.findMany({
      where: {
        kind: "PRIMARY",
        state: "ACTIVE",
        ticket: { eventId: { in: ids }, mintStatus: "MINTED", primarySoldAt: null },
      },
      select: { amountDrops: true, ticket: { select: { tierId: true } } },
    }),
  ]);

  const inFlight =
    unsoldMinted.length === 0
      ? []
      : await db.ledgerTransaction.findMany({
          where: {
            type: "NFTokenAcceptOffer",
            status: "PENDING",
            relatedTicketId: { in: unsoldMinted.map((t) => t.id) },
          },
          select: { relatedTicketId: true },
        });
  const pendingTickets = new Set(inFlight.map((t) => t.relatedTicketId));

  const soldByTier = countByTier(sold);
  const pendingByTier = countByTier(unsoldMinted.filter((t) => pendingTickets.has(t.id)));
  const asksByTier = new Map<string, string[]>();
  for (const offer of asks) {
    const tierId = offer.ticket?.tierId;
    if (!tierId) continue;
    asksByTier.set(tierId, [...(asksByTier.get(tierId) ?? []), offer.amountDrops]);
  }

  for (const eventId of ids) {
    const tierRows = tiers
      .filter((t) => t.eventId === eventId)
      .map((t) =>
        summariseTier({
          tierId: t.id,
          name: t.name,
          priceDrops: t.priceDrops,
          totalSupply: t.totalSupply,
          sold: soldByTier.get(t.id) ?? 0,
          pending: pendingByTier.get(t.id) ?? 0,
          activeAsks: asksByTier.get(t.id) ?? [],
        }),
      );
    result.set(eventId, summariseEvent(eventId, tierRows, now));
  }
  return result;
}

export async function getPrimaryAvailability(db: Db, eventId: string, now = new Date()): Promise<PrimaryAvailability> {
  return (await getPrimaryAvailabilityMany(db, [eventId], now)).get(eventId)!;
}

/** Whether every primary ticket of the event has a validated sale (the resale trigger). */
export async function isPrimarySoldOut(db: Db, eventId: string): Promise<boolean> {
  return (await getPrimaryAvailability(db, eventId)).isSoldOut;
}

/**
 * The real `InventoryPort` (src/features/integration/ports.ts) for the UI and the resale policy:
 *   new ResalePolicy({ inventory: createInventoryPort(), ... })
 */
export function createInventoryPort(db: Db = getDb()): InventoryPort {
  return {
    getAvailability: (eventId): Promise<EventAvailability> => getPrimaryAvailability(db, eventId),
    getAvailabilityMany: (eventIds): Promise<Map<string, EventAvailability>> => getPrimaryAvailabilityMany(db, eventIds),
  };
}
