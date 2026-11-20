/**
 * Proof of attendance for reviews (XRPL-079), on tables that already exist.
 *
 * CheckInRecord stores the admitted wallet, not a user, so a customer attended when one of their
 * verified, unrevoked WalletLink addresses has a check-in for the event. An unverified link proves
 * nothing (see the WalletLink schema note), so it never counts.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { Attendance, AttendanceVerifier } from "./review-service";

export class PrismaAttendance implements AttendanceVerifier {
  constructor(private readonly db: Pick<PrismaClient, "walletLink" | "checkInRecord">) {}

  async findAttendance(userId: string, eventId: string): Promise<Attendance | null> {
    const wallets = await this.db.walletLink.findMany({
      where: { userId, verifiedAt: { not: null }, revokedAt: null },
      select: { address: true },
    });
    if (wallets.length === 0) return null;
    const record = await this.db.checkInRecord.findFirst({
      where: { eventId, walletAddress: { in: wallets.map((w) => w.address) } },
      orderBy: { scannedAt: "asc" },
      select: { id: true },
    });
    return record ? { checkInRecordId: record.id } : null;
  }
}
