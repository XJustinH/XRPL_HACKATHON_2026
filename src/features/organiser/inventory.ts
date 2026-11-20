/**
 * Seller ticket inventory per tier (XRPL-021).
 *
 * Counts come from records the app writes only after a validated XRPL transaction
 * (mintStatus MINTED, primarySoldAt), so a purchase shows up once it is confirmed on the
 * ledger and never from optimistic client state.
 *
 * `primarySoldOut` here is a display figure. The authoritative sell-out rule is Agent A's
 * InventoryPort (XRPL-020); the resale policy (XRPL-037) uses that, not this.
 */
import type { EventInventory, TierInventory } from "@/contracts/checkin";
import type { PrismaClient } from "@/generated/prisma/client";

type Db = Pick<PrismaClient, "ticketTier" | "ticketNFT" | "checkInRecord">;

export async function getEventInventory(db: Db, eventId: string, now = new Date()): Promise<EventInventory> {
  const countBy = async (where: Parameters<Db["ticketNFT"]["groupBy"]>[0]["where"]) => {
    const rows = await db.ticketNFT.groupBy({ by: ["tierId"], where: { eventId, ...where }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.tierId, r._count._all]));
  };

  const [tiers, minted, minting, sold, onSale, checkedIn] = await Promise.all([
    db.ticketTier.findMany({
      where: { eventId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, priceDrops: true, totalSupply: true },
    }),
    countBy({ mintStatus: "MINTED" }),
    countBy({ mintStatus: { in: ["PENDING", "SUBMITTED"] } }),
    countBy({ mintStatus: "MINTED", primarySoldAt: { not: null } }),
    countBy({ mintStatus: "MINTED", primarySoldAt: null, offers: { some: { kind: "PRIMARY", state: "ACTIVE" } } }),
    db.checkInRecord.count({ where: { eventId } }),
  ]);

  const rows: TierInventory[] = tiers.map((t) => {
    const s = sold.get(t.id) ?? 0;
    return {
      tierId: t.id,
      name: t.name,
      priceDrops: t.priceDrops,
      total: t.totalSupply,
      minted: minted.get(t.id) ?? 0,
      minting: minting.get(t.id) ?? 0,
      onSale: onSale.get(t.id) ?? 0,
      sold: s,
      unsold: Math.max(0, t.totalSupply - s),
    };
  });

  const sum = (k: keyof EventInventory["totals"]) => rows.reduce((n, r) => n + r[k], 0);
  const totals = {
    total: sum("total"),
    minted: sum("minted"),
    minting: sum("minting"),
    onSale: sum("onSale"),
    sold: sum("sold"),
    unsold: sum("unsold"),
  };
  return {
    eventId,
    tiers: rows,
    totals,
    primarySoldOut: rows.length > 0 && rows.every((r) => r.total > 0 && r.sold >= r.total),
    checkedIn,
    calculatedAt: now.toISOString(),
  };
}
