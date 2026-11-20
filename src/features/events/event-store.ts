import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { EventDraftInput, EventView, TicketTierView } from "@/contracts";

/**
 * Event reads and writes for the seller management views (XRPL-015).
 *
 * Returns `EventView`, the read model the UI renders, rather than raw rows. Any
 * value the UI treats as derived — a tier's `remaining` and `locked` flags —
 * is computed here so no component recalculates it.
 *
 * Primary sell-out state is **not** computed here: that is the live inventory
 * calculation in XRPL-020, which also reconciles against the ledger.
 */

type EventDb = Pick<PrismaClient, "event">;

/** Tiers are ordered by the seller's own ordering, then by age as a tiebreak. */
const eventInclude = {
  seller: { select: { id: true, displayName: true, role: true } },
  tiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.EventInclude;

/** The exact row shape `eventInclude` produces, inferred rather than restated. */
type EventRow = Prisma.EventGetPayload<{ include: typeof eventInclude }>;

function toTierView(tier: EventRow["tiers"][number]): TicketTierView {
  /*
   * `soldQuantity` stays 0 until primary sales are reconciled (XRPL-032). It is
   * deliberately not inferred from `mintedQuantity`: a minted ticket is stock
   * that exists on the ledger, not stock that someone has bought.
   */
  const soldQuantity = 0;
  return {
    id: tier.id,
    eventId: tier.eventId,
    name: tier.name,
    description: tier.description,
    priceDrops: tier.priceDrops,
    totalSupply: tier.totalSupply,
    mintedQuantity: tier.mintedQuantity,
    soldQuantity,
    remaining: Math.max(0, tier.totalSupply - soldQuantity),
    locked: tier.mintedQuantity > 0,
  };
}

export function toEventView(row: EventRow): EventView {
  return {
    id: row.id,
    seller: {
      id: row.seller.id,
      displayName: row.seller.displayName,
      city: null,
      isVerified: false,
    },
    title: row.title,
    description: row.description,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    venue: row.venue,
    city: row.city,
    status: row.status,
    artworkUrl: row.artworkUrl,
    tiers: row.tiers.map(toTierView),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

/**
 * Creates an event owned by `sellerId`, always as a DRAFT.
 *
 * Publishing is a separate, validated transition (XRPL-017), so this never
 * accepts a status from the caller. An empty `artworkUrl` is stored as null so
 * "cleared" and "never set" are the same state.
 */
export async function createEventDraft(
  db: EventDb,
  sellerId: string,
  input: EventDraftInput,
): Promise<EventView> {
  const row = await db.event.create({
    data: {
      sellerId,
      title: input.title,
      description: input.description,
      startsAt: new Date(input.startsAt),
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      venue: input.venue,
      city: input.city,
      artworkUrl: input.artworkUrl?.trim() ? input.artworkUrl : null,
      status: "DRAFT",
    },
    include: eventInclude,
  });
  return toEventView(row);
}

/** Every event owned by a seller, soonest first, drafts included. */
export async function listSellerEvents(db: EventDb, sellerId: string): Promise<EventView[]> {
  const rows = await db.event.findMany({
    where: { sellerId },
    orderBy: [{ startsAt: "asc" }],
    include: eventInclude,
  });
  return rows.map(toEventView);
}
