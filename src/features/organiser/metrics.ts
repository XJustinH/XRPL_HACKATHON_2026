/**
 * Ticket, resale and check-in metrics for one event (XRPL-076).
 *
 * Confirmed figures count only validated activity: primary sales are `primarySoldAt` (XRPL-032),
 * and offer amounts come from offers in state ACCEPTED (validated NFTokenAcceptOffer). XRP amounts
 * are summed as integer drops (BigInt), never floats. Activity that is requested or signed but not
 * yet validated is reported separately under `pending` and never mixed into the confirmed figures.
 */
import type { EventMetrics } from "@/contracts/checkin";
import type { PrismaClient } from "@/generated/prisma/client";

type Db = Pick<PrismaClient, "ticketTier" | "ticketNFT" | "nFTOffer" | "checkInRecord" | "ledgerTransaction">;

/** Bucket sizes tried in order; the first that keeps the timeline at or under MAX_BUCKETS wins. */
const BUCKET_MINUTES = [5, 15, 30, 60, 120, 240, 1440] as const;
const MAX_BUCKETS = 32;

export async function getEventMetrics(db: Db, eventId: string, now = new Date()): Promise<EventMetrics> {
  const accepted = { ticket: { eventId }, state: "ACCEPTED" as const };
  const [supply, primarySold, offers, scans, ticketIds, pendingListings, pendingMints] = await Promise.all([
    db.ticketTier.aggregate({ where: { eventId }, _sum: { totalSupply: true } }),
    db.ticketNFT.count({ where: { eventId, primarySoldAt: { not: null } } }),
    db.nFTOffer.findMany({ where: accepted, select: { kind: true, amountDrops: true } }),
    db.checkInRecord.findMany({ where: { eventId }, select: { scannedAt: true }, orderBy: { scannedAt: "asc" } }),
    db.ticketNFT.findMany({ where: { eventId }, select: { id: true } }),
    db.nFTOffer.count({ where: { ticket: { eventId }, state: "PENDING_SIGNATURE" } }),
    db.ticketNFT.count({ where: { eventId, mintStatus: { in: ["PENDING", "SUBMITTED"] } } }),
  ]);
  // LedgerTransaction links to tickets by id only (no relation), so filter by this event's ticket ids.
  const pendingPurchases =
    ticketIds.length === 0
      ? 0
      : await db.ledgerTransaction.count({
          where: { status: "PENDING", type: "NFTokenAcceptOffer", relatedTicketId: { in: ticketIds.map((t) => t.id) } },
        });

  let primaryRevenue = BigInt(0);
  let resaleVolume = BigInt(0);
  let resales = 0;
  let privateTransfers = 0;
  let gifts = 0;
  for (const o of offers) {
    if (o.kind === "PRIMARY") primaryRevenue += BigInt(o.amountDrops);
    else if (o.kind === "RESALE") {
      resales += 1;
      resaleVolume += BigInt(o.amountDrops);
    } else if (o.kind === "PRIVATE") privateTransfers += 1;
    else if (o.kind === "GIFT") gifts += 1;
  }

  const { bucketMinutes, timeline } = bucketCheckIns(scans.map((s) => s.scannedAt));
  return {
    eventId,
    ticketsTotal: supply._sum.totalSupply ?? 0,
    primarySold,
    primaryRevenueDrops: primaryRevenue.toString(),
    resales,
    resaleVolumeDrops: resaleVolume.toString(),
    privateTransfers,
    gifts,
    checkedIn: scans.length,
    notCheckedIn: Math.max(0, primarySold - scans.length),
    pending: { purchases: pendingPurchases, listings: pendingListings, mints: pendingMints },
    checkInTimeline: timeline,
    bucketMinutes,
    calculatedAt: now.toISOString(),
  };
}

/** Groups scan times into equal buckets from the first to the last check-in, keeping empty buckets. */
export function bucketCheckIns(times: Date[]): { bucketMinutes: number; timeline: EventMetrics["checkInTimeline"] } {
  if (times.length === 0) return { bucketMinutes: 15, timeline: [] };
  const ms = times.map((t) => t.getTime());
  const first = Math.min(...ms);
  const last = Math.max(...ms);
  const minutes = BUCKET_MINUTES.find((m) => Math.floor((last - first) / (m * 60_000)) + 1 <= MAX_BUCKETS) ?? 1440;
  const size = minutes * 60_000;
  const start = Math.floor(first / size) * size;
  const n = Math.floor((last - start) / size) + 1;
  const counts = new Array<number>(n).fill(0);
  for (const t of ms) counts[Math.floor((t - start) / size)]! += 1;
  return {
    bucketMinutes: minutes,
    timeline: counts.map((count, i) => ({ start: new Date(start + i * size).toISOString(), count })),
  };
}
