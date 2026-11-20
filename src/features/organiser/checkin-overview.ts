/** Entry overview for the organiser's gate screen (XRPL-048). */
import type { CheckInOverview } from "@/contracts/checkin";
import type { PrismaClient } from "@/generated/prisma/client";

export const RECENT_CHECKINS = 10;

export async function getCheckInOverview(
  db: Pick<PrismaClient, "ticketNFT" | "checkInRecord">,
  eventId: string,
): Promise<CheckInOverview> {
  const [mintedTickets, admitted, recent] = await Promise.all([
    db.ticketNFT.count({ where: { eventId, mintStatus: "MINTED" } }),
    db.checkInRecord.count({ where: { eventId } }),
    db.checkInRecord.findMany({
      where: { eventId },
      orderBy: { scannedAt: "desc" },
      take: RECENT_CHECKINS,
      select: {
        ticketId: true,
        walletAddress: true,
        scannedAt: true,
        ticket: { select: { serial: true, tier: { select: { name: true } } } },
      },
    }),
  ]);
  return {
    eventId,
    mintedTickets,
    admitted,
    recent: recent.map((r) => ({
      ticketId: r.ticketId,
      serial: r.ticket.serial,
      tierName: r.ticket.tier.name,
      walletAddress: r.walletAddress,
      scannedAt: r.scannedAt.toISOString(),
    })),
  };
}
