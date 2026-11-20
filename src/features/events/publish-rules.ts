import type { EventPatch, EventView } from "@/contracts";

/**
 * Draft, edit and publish rules (XRPL-017).
 *
 * Pure functions so the route handlers, the UI and the tests all reason about
 * the same rules. Persistence lives in `./event-store`.
 */

/**
 * Event fields that are copied into a ticket's NFT metadata at mint time.
 *
 * Once a ticket exists on the ledger its metadata is immutable, so changing any
 * of these afterwards would leave the token describing an event that no longer
 * matches the application. They are therefore frozen once minting has started.
 *
 * This set must stay in step with the ticket metadata schema (XRPL-022). If
 * that schema adds or drops a field, change this list with it.
 *
 * Verified against `buildTicketMetadata` in `src/lib/xrpl/tickets/metadata.ts`:
 * the title, start, end, venue and city appear in `event` and `attributes`;
 * the artwork becomes the token's `image`; and the **description is embedded in
 * the token's `description`**, which is why it is frozen here too.
 */
export const NFT_RELEVANT_FIELDS = [
  "title",
  "description",
  "startsAt",
  "endsAt",
  "venue",
  "city",
  "artworkUrl",
] as const satisfies readonly (keyof EventPatch)[];

export type NftRelevantField = (typeof NFT_RELEVANT_FIELDS)[number];

/** Human labels for the messages shown when a field is frozen. */
const FIELD_LABELS: Record<NftRelevantField, string> = {
  title: "event name",
  description: "description",
  startsAt: "start time",
  endsAt: "end time",
  venue: "venue",
  city: "city",
  artworkUrl: "artwork",
};

/** True once any ticket in any tier has been minted. */
export function hasMintedTickets(event: Pick<EventView, "tiers">): boolean {
  return event.tiers.some((tier) => tier.mintedQuantity > 0);
}

export function mintedTicketCount(event: Pick<EventView, "tiers">): number {
  return event.tiers.reduce((sum, tier) => sum + tier.mintedQuantity, 0);
}

/**
 * The NFT-relevant fields a patch would change.
 *
 * A field set to its current value is not a change, so re-saving an unmodified
 * form never trips the restriction.
 */
export function lockedFieldsInPatch(
  event: EventView,
  patch: EventPatch,
): NftRelevantField[] {
  if (!hasMintedTickets(event)) return [];

  return NFT_RELEVANT_FIELDS.filter((field) => {
    if (!(field in patch)) return false;
    const next = patch[field];
    if (next === undefined) return false;

    if (field === "artworkUrl") {
      // "" and null both mean "no artwork"; treat them as equivalent.
      const current = event.artworkUrl ?? "";
      return (next ?? "") !== current;
    }
    if (field === "startsAt" || field === "endsAt") {
      // Compare as instants so an equivalent offset is not read as a change.
      const currentIso = event[field];
      if (next === null || currentIso === null) return next !== currentIso;
      return new Date(next).getTime() !== new Date(currentIso).getTime();
    }
    return next !== event[field];
  });
}

export function describeLockedFields(fields: readonly NftRelevantField[]): string {
  const labels = fields.map((field) => FIELD_LABELS[field]);
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/* ------------------------------------------------------------------ */

export type PublishBlocker =
  | { code: "NO_TIERS"; message: string }
  | { code: "NO_SUPPLY"; message: string }
  | { code: "EVENT_IN_PAST"; message: string };

/**
 * Why an event may not be published yet, in the order a seller should fix them.
 *
 * Returning the full list rather than the first problem lets the UI show
 * everything outstanding instead of revealing one blocker per attempt.
 */
export function publishBlockers(event: EventView, now = new Date()): PublishBlocker[] {
  const blockers: PublishBlocker[] = [];

  if (event.tiers.length === 0) {
    blockers.push({
      code: "NO_TIERS",
      message: "Add at least one ticket tier so buyers have something to buy.",
    });
  } else if (event.tiers.every((tier) => tier.totalSupply < 1)) {
    blockers.push({
      code: "NO_SUPPLY",
      message: "At least one tier needs a quantity of one or more.",
    });
  }

  const startsAt = new Date(event.startsAt);
  if (!Number.isNaN(startsAt.getTime()) && startsAt.getTime() <= now.getTime()) {
    blockers.push({
      code: "EVENT_IN_PAST",
      message: "This event's start time has already passed. Update it before publishing.",
    });
  }

  return blockers;
}

export function canPublish(event: EventView, now = new Date()): boolean {
  return event.status === "DRAFT" && publishBlockers(event, now).length === 0;
}

/**
 * Whether an event may be returned to draft.
 *
 * Refused once tickets exist on the ledger: buyers may already hold them, and
 * hiding the event would strip the public page their ticket refers to.
 */
export function canUnpublish(event: EventView): boolean {
  return event.status === "PUBLISHED" && !hasMintedTickets(event);
}
