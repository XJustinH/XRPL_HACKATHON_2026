/**
 * Events a customer actually attended: admitted at the door (XRPL-047) with one of their verified,
 * unrevoked wallets. Used by the profile's history section (XRPL-056) and as the real
 * `AttendancePort` (`src/features/integration/ports.ts`) for history pages (XRPL-063).
 *
 * CheckInRecord stores the admitted wallet, not a user, so the match goes through WalletLink;
 * an unverified link proves nothing and never counts.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { AttendancePort } from "@/features/integration/ports";

type Db = Pick<PrismaClient, "walletLink" | "checkInRecord">;

export type AttendedEvent = {
  eventId: string;
  title: string;
  startsAt: string;
  venue: string;
  city: string;
  /** The first admission to this event. */
  checkedInAt: string;
};

export async function listAttendedEvents(db: Db, userId: string, limit = 20): Promise<AttendedEvent[]> {
  const wallets = await db.walletLink.findMany({
    where: { userId, verifiedAt: { not: null }, revokedAt: null },
    select: { address: true },
  });
  if (wallets.length === 0) return [];

  const records = await db.checkInRecord.findMany({
    where: { walletAddress: { in: wallets.map((w) => w.address) } },
    orderBy: { scannedAt: "asc" },
    select: {
      scannedAt: true,
      event: { select: { id: true, title: true, startsAt: true, venue: true, city: true } },
    },
  });

  // One entry per event (someone can enter with several tickets), keeping the first admission.
  const byEvent = new Map<string, AttendedEvent>();
  for (const r of records) {
    if (byEvent.has(r.event.id)) continue;
    byEvent.set(r.event.id, {
      eventId: r.event.id,
      title: r.event.title,
      startsAt: r.event.startsAt.toISOString(),
      venue: r.event.venue,
      city: r.event.city,
      checkedInAt: r.scannedAt.toISOString(),
    });
  }
  return [...byEvent.values()].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, limit);
}

/** The real AttendancePort: event IDs the user has a confirmed check-in for. */
export function prismaAttendancePort(db: Db): AttendancePort {
  return {
    async listAttendedEventIds(userId) {
      return (await listAttendedEvents(db, userId, Number.MAX_SAFE_INTEGER)).map((e) => e.eventId);
    },
  };
}
