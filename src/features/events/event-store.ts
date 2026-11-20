import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  EventDraftInput,
  EventPatch,
  EventView,
  Page,
  TicketTierInput,
  TicketTierPatch,
  TicketTierView,
} from "@/contracts";
import {
  describeLockedFields,
  hasMintedTickets,
  lockedFieldsInPatch,
  publishBlockers,
} from "./publish-rules";

/**
 * Event and ticket-tier reads and writes for the seller management views
 * (XRPL-015, XRPL-016).
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

/** A single event with its tiers, regardless of status. Null when unknown. */
export async function getEventView(db: EventDb, eventId: string): Promise<EventView | null> {
  const row = await db.event.findUnique({ where: { id: eventId }, include: eventInclude });
  return row ? toEventView(row) : null;
}

/**
 * Encodes a keyset cursor for the public listing.
 *
 * The pair (startsAt, id) is unique and matches the sort order, so paging is
 * stable even when events are published while a reader is part-way through —
 * which an offset would not be. The value is opaque by contract; callers must
 * not parse it.
 */
export function encodeEventCursor(event: { startsAt: string; id: string }): string {
  return Buffer.from(`${event.startsAt}|${event.id}`, "utf8").toString("base64url");
}

function decodeEventCursor(cursor: string): { startsAt: Date; id: string } | null {
  try {
    const [startsAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!startsAt || !id) return null;
    const date = new Date(startsAt);
    return Number.isNaN(date.getTime()) ? null : { startsAt: date, id };
  } catch {
    return null;
  }
}

/**
 * Published, not-yet-started events, soonest first (XRPL-018).
 *
 * Status and start time are filtered in the query rather than after loading, so
 * a draft or a finished event cannot reach a public response by accident.
 *
 * Text, city, date and price filters belong to XRPL-059 and are deliberately
 * not read here: accepting a filter and silently ignoring it would be worse
 * than not offering it yet.
 */
export async function listPublishedEvents(
  db: EventDb,
  options: { now?: Date; limit?: number; cursor?: string } = {},
): Promise<Page<EventView>> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
  const after = options.cursor ? decodeEventCursor(options.cursor) : null;

  // An unreadable cursor is treated as no cursor: a bad link shows the first
  // page instead of an error.
  const keyset = after
    ? {
        OR: [
          { startsAt: { gt: after.startsAt } },
          { startsAt: after.startsAt, id: { gt: after.id } },
        ],
      }
    : {};

  const rows = await db.event.findMany({
    where: { status: "PUBLISHED", startsAt: { gt: now }, ...keyset },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    // One extra row reveals whether another page exists without a second count.
    take: limit + 1,
    include: eventInclude,
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toEventView);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeEventCursor(last) : null,
  };
}

/** A published event by id. Returns null for drafts, so callers cannot leak one. */
export async function getPublishedEvent(
  db: EventDb,
  eventId: string,
): Promise<EventView | null> {
  const row = await db.event.findFirst({
    where: { id: eventId, status: "PUBLISHED" },
    include: eventInclude,
  });
  return row ? toEventView(row) : null;
}

/** Raised when an event state change is refused by a domain rule. */
export class EventRuleError extends Error {
  constructor(
    readonly code:
      | "EVENT_NOT_FOUND"
      | "FIELDS_LOCKED_BY_MINT"
      | "NOT_PUBLISHABLE"
      | "ALREADY_PUBLISHED"
      | "NOT_PUBLISHED"
      | "HAS_MINTED_TICKETS",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EventRuleError";
  }
}

async function requireEventView(db: EventDb, eventId: string): Promise<EventView> {
  const event = await getEventView(db, eventId);
  if (!event) throw new EventRuleError("EVENT_NOT_FOUND", "Event not found");
  return event;
}

/**
 * Edits an event's details.
 *
 * Fields that are copied into ticket NFT metadata are frozen once minting has
 * started; see `NFT_RELEVANT_FIELDS`. Everything else stays editable in both
 * draft and published states.
 */
export async function updateEvent(
  db: EventDb,
  eventId: string,
  patch: EventPatch,
): Promise<EventView> {
  const event = await requireEventView(db, eventId);

  const locked = lockedFieldsInPatch(event, patch);
  if (locked.length > 0) {
    throw new EventRuleError(
      "FIELDS_LOCKED_BY_MINT",
      `Tickets for this event are already on the ledger, so the ${describeLockedFields(
        locked,
      )} cannot be changed.`,
      { fields: locked },
    );
  }

  const row = await db.event.update({
    where: { id: eventId },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.startsAt !== undefined ? { startsAt: new Date(patch.startsAt) } : {}),
      ...(patch.endsAt !== undefined
        ? { endsAt: patch.endsAt ? new Date(patch.endsAt) : null }
        : {}),
      ...(patch.venue !== undefined ? { venue: patch.venue } : {}),
      ...(patch.city !== undefined ? { city: patch.city } : {}),
      ...(patch.artworkUrl !== undefined
        ? { artworkUrl: patch.artworkUrl?.trim() ? patch.artworkUrl : null }
        : {}),
    },
    include: eventInclude,
  });
  return toEventView(row);
}

/**
 * Publishes a draft after checking it is complete.
 *
 * `publishedAt` is set only on the first publish, so re-publishing after a
 * return to draft does not rewrite the original publication time.
 */
export async function publishEvent(
  db: EventDb,
  eventId: string,
  now = new Date(),
): Promise<EventView> {
  const event = await requireEventView(db, eventId);
  if (event.status === "PUBLISHED") {
    throw new EventRuleError("ALREADY_PUBLISHED", "This event is already published");
  }

  const blockers = publishBlockers(event, now);
  if (blockers.length > 0) {
    throw new EventRuleError("NOT_PUBLISHABLE", "This event is not ready to publish", {
      blockers,
    });
  }

  const row = await db.event.update({
    where: { id: eventId },
    data: { status: "PUBLISHED", publishedAt: event.publishedAt ? undefined : now },
    include: eventInclude,
  });
  return toEventView(row);
}

/** Returns a published event to draft, hiding it from the public listing. */
export async function unpublishEvent(db: EventDb, eventId: string): Promise<EventView> {
  const event = await requireEventView(db, eventId);
  if (event.status !== "PUBLISHED") {
    throw new EventRuleError("NOT_PUBLISHED", "This event is not published");
  }
  if (hasMintedTickets(event)) {
    throw new EventRuleError(
      "HAS_MINTED_TICKETS",
      "Tickets for this event are already on the ledger, so it cannot be hidden from buyers.",
    );
  }

  const row = await db.event.update({
    where: { id: eventId },
    data: { status: "DRAFT" },
    include: eventInclude,
  });
  return toEventView(row);
}

type TierDb = Pick<PrismaClient, "event" | "ticketTier" | "ticketNFT">;

/** Raised when a tier change is refused by a domain rule, not by validation. */
export class TierRuleError extends Error {
  constructor(
    readonly code:
      | "DUPLICATE_TIER_NAME"
      | "TIER_LOCKED"
      | "SUPPLY_BELOW_MINTED"
      | "TIER_HAS_TICKETS"
      | "TIER_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "TierRuleError";
  }
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function requireTier(db: TierDb, eventId: string, tierId: string) {
  const tier = await db.ticketTier.findUnique({
    where: { id: tierId },
    select: { id: true, eventId: true, mintedQuantity: true },
  });
  // Checking the parent event prevents a tier being reached through an event
  // the caller happens to own.
  if (!tier || tier.eventId !== eventId) {
    throw new TierRuleError("TIER_NOT_FOUND", "Ticket tier not found");
  }
  return tier;
}

/**
 * Adds a ticket tier to an event.
 *
 * New tiers are appended after the existing ones so the seller's ordering is
 * preserved without them having to supply a position.
 */
export async function addTier(
  db: TierDb,
  eventId: string,
  input: TicketTierInput,
): Promise<EventView> {
  const last = await db.ticketTier.findFirst({
    where: { eventId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  try {
    await db.ticketTier.create({
      data: {
        eventId,
        name: input.name,
        description: input.description,
        priceDrops: input.priceDrops,
        totalSupply: input.totalSupply,
        sortOrder: input.sortOrder || (last ? last.sortOrder + 1 : 0),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TierRuleError(
        "DUPLICATE_TIER_NAME",
        `This event already has a tier called "${input.name}"`,
      );
    }
    throw error;
  }

  const view = await getEventView(db, eventId);
  if (!view) throw new TierRuleError("TIER_NOT_FOUND", "Event not found");
  return view;
}

/**
 * Edits a tier.
 *
 * Price and supply carry an on-ledger commitment once any ticket in the tier
 * has been minted, so a locked tier rejects those two fields while still
 * allowing the name and description to be corrected. Supply can be raised at
 * any time but never dropped below what has already been minted.
 */
export async function updateTier(
  db: TierDb,
  eventId: string,
  tierId: string,
  input: TicketTierPatch,
): Promise<EventView> {
  const tier = await requireTier(db, eventId, tierId);
  const locked = tier.mintedQuantity > 0;

  if (locked && input.priceDrops !== undefined) {
    throw new TierRuleError(
      "TIER_LOCKED",
      "This tier's price is fixed because tickets have already been minted",
    );
  }
  if (input.totalSupply !== undefined && input.totalSupply < tier.mintedQuantity) {
    throw new TierRuleError(
      "SUPPLY_BELOW_MINTED",
      `Quantity cannot be lower than the ${tier.mintedQuantity} ticket(s) already minted`,
    );
  }

  try {
    await db.ticketTier.update({
      where: { id: tierId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.priceDrops !== undefined ? { priceDrops: input.priceDrops } : {}),
        ...(input.totalSupply !== undefined ? { totalSupply: input.totalSupply } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TierRuleError(
        "DUPLICATE_TIER_NAME",
        `This event already has a tier called "${input.name}"`,
      );
    }
    throw error;
  }

  const view = await getEventView(db, eventId);
  if (!view) throw new TierRuleError("TIER_NOT_FOUND", "Event not found");
  return view;
}

/**
 * Removes a tier.
 *
 * Refused once any ticket row exists for it, including tickets that are still
 * pending a mint: those rows are the record of an attempted on-ledger action
 * and must not be orphaned.
 */
export async function removeTier(
  db: TierDb,
  eventId: string,
  tierId: string,
): Promise<EventView> {
  await requireTier(db, eventId, tierId);

  const ticketCount = await db.ticketNFT.count({ where: { tierId } });
  if (ticketCount > 0) {
    throw new TierRuleError(
      "TIER_HAS_TICKETS",
      "This tier cannot be removed because tickets have been created for it",
    );
  }

  await db.ticketTier.delete({ where: { id: tierId } });
  const view = await getEventView(db, eventId);
  if (!view) throw new TierRuleError("TIER_NOT_FOUND", "Event not found");
  return view;
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
