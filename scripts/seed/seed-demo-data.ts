import type { PrismaClient } from "@/generated/prisma/client";
import { DEMO_LABEL, demoEvents, demoTiers, demoUsers } from "./fixtures";

/**
 * Idempotent demo seed (XRPL-008).
 *
 * Semantics:
 *  - Create-only: records missing from the database are inserted; records that already exist
 *    (matched by their fixed ID) are left as the app left them. A re-run never resets
 *    inventory, publication state or edits made during a demo.
 *  - One exception: `User.isDemo` is restored to true on the demo users. It identifies them as demo
 *    personas rather than being app state, and a row seeded by an older checkout (before the column
 *    existed) or flipped by hand would otherwise drop out of demo login without any error.
 *  - Additive: touches only the fixture IDs. Nothing else is read, changed or deleted.
 *  - Atomic: everything runs in one transaction, so a failed run leaves no partial demo data.
 *  - Safe to run concurrently: inserts use ON CONFLICT DO NOTHING on the primary key.
 *
 * A clash on another unique key (e.g. a tier with the same name already on a demo event under a
 * different ID) would make ON CONFLICT skip the fixture silently, so every fixture ID is verified
 * after insert and the run fails loudly if one is missing.
 */

export type SeedTableSummary = { created: number; existing: number };

export type SeedSummary = {
  users: SeedTableSummary;
  events: SeedTableSummary;
  tiers: SeedTableSummary;
  /** Existing demo users whose `isDemo` flag was false and has been set back to true. */
  demoFlagsRestored: number;
  /** Existing rows still carrying the old `[DEMO] ` name prefix, now renamed without it. */
  unlabelled: { users: number; events: number };
};

export class SeedConflictError extends Error {
  constructor(
    readonly table: string,
    readonly missingIds: string[],
  ) {
    super(
      `Could not seed ${table} ${missingIds.join(", ")}: a conflicting record (another unique field) already exists. ` +
        "Remove the conflicting record or reset the database, then re-run the seed.",
    );
    this.name = "SeedConflictError";
  }
}

const summarise = (total: number, created: number): SeedTableSummary => ({
  created,
  existing: total - created,
});

function assertAllPresent(table: string, expected: readonly { id: string }[], found: { id: string }[]) {
  const foundIds = new Set(found.map((r) => r.id));
  const missing = expected.map((r) => r.id).filter((id) => !foundIds.has(id));
  if (missing.length > 0) throw new SeedConflictError(table, missing);
}

export async function seedDemoData(db: PrismaClient): Promise<SeedSummary> {
  return db.$transaction(async (tx) => {
    // Insert parents before children (events reference sellers, tiers reference events).
    const users = await tx.user.createMany({ data: [...demoUsers], skipDuplicates: true });
    const events = await tx.event.createMany({ data: [...demoEvents], skipDuplicates: true });
    const tiers = await tx.ticketTier.createMany({ data: [...demoTiers], skipDuplicates: true });

    const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id);
    const restored = await tx.user.updateMany({
      where: { id: { in: ids(demoUsers) }, isDemo: false },
      data: { isDemo: true },
    });
    // Demo events seeded before events had a category get one; a category set since is kept.
    // Artwork is backfilled on the same terms: only where the column is still null, so a seller
    // who cleared or replaced the demo artwork during a demo does not have it reinstated.
    for (const event of demoEvents) {
      await tx.event.updateMany({
        where: { id: event.id, category: null },
        data: { category: event.category },
      });
      await tx.event.updateMany({
        where: { id: event.id, artworkUrl: null },
        data: { artworkUrl: event.artworkUrl },
      });
    }

    /*
     * Drop the `[DEMO] ` prefix that titles and display names used to carry.
     *
     * `createMany` skips rows that already exist, so a database seeded before the prefix was
     * removed would otherwise keep the old names for good. Each update matches the exact previous
     * labelled value rather than overwriting whatever is stored: a name edited since is left
     * alone, and the update becomes a no-op once it has run.
     */
    let renamedUsers = 0;
    for (const user of demoUsers) {
      const { count } = await tx.user.updateMany({
        where: { id: user.id, displayName: `${DEMO_LABEL} ${user.displayName}` },
        data: { displayName: user.displayName },
      });
      renamedUsers += count;
    }

    let renamedEvents = 0;
    for (const event of demoEvents) {
      const { count } = await tx.event.updateMany({
        where: {
          id: event.id,
          title: `${DEMO_LABEL} ${event.title}`,
          // An event with minted tickets keeps its old title: the title is copied into the NFT
          // metadata at mint time (NFT_RELEVANT_FIELDS in publish-rules.ts) and the ledger holds
          // that immutably, so renaming it here would leave the token describing another event.
          tiers: { none: { mintedQuantity: { gt: 0 } } },
        },
        data: { title: event.title },
      });
      renamedEvents += count;
    }

    assertAllPresent(
      "user",
      demoUsers,
      await tx.user.findMany({ where: { id: { in: ids(demoUsers) } }, select: { id: true } }),
    );
    assertAllPresent(
      "event",
      demoEvents,
      await tx.event.findMany({ where: { id: { in: ids(demoEvents) } }, select: { id: true } }),
    );
    assertAllPresent(
      "ticket tier",
      demoTiers,
      await tx.ticketTier.findMany({ where: { id: { in: ids(demoTiers) } }, select: { id: true } }),
    );

    return {
      users: summarise(demoUsers.length, users.count),
      events: summarise(demoEvents.length, events.count),
      tiers: summarise(demoTiers.length, tiers.count),
      demoFlagsRestored: restored.count,
      unlabelled: { users: renamedUsers, events: renamedEvents },
    };
  });
}
