/**
 * Prisma implementations of the check-in store and ticket lookup (XRPL-047).
 *
 * One-time admission relies on two database guarantees, not on application checks:
 *  - `UPDATE CheckInChallenge SET consumedAt WHERE id = ? AND consumedAt IS NULL`: under
 *    Postgres row locking, a concurrent second update sees the committed value and matches 0 rows.
 *  - `CheckInRecord @@unique([ticketId, eventId])`: a second record for the same ticket fails
 *    with P2002 and the whole transaction (including the challenge update) rolls back.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { AdmitOutcome, CheckInStore, NewCheckInRecord, StoredChallenge, TicketDirectory, TicketRef } from "./ports";

type Db = Pick<PrismaClient, "checkInChallenge" | "checkInRecord" | "ticketNFT" | "$transaction">;

export class PrismaCheckInStore implements CheckInStore {
  constructor(private readonly db: Db) {}

  async createChallenge(c: StoredChallenge): Promise<void> {
    await this.db.checkInChallenge.create({
      data: {
        id: c.id,
        nonce: c.nonce,
        ticketId: c.ticketId,
        eventId: c.eventId,
        walletAddress: c.walletAddress,
        expiresAt: c.expiresAt,
        consumedAt: c.consumedAt,
        proofReference: c.proofReference,
      },
    });
  }

  async getChallenge(id: string): Promise<StoredChallenge | null> {
    return this.db.checkInChallenge.findUnique({
      where: { id },
      select: {
        id: true,
        nonce: true,
        ticketId: true,
        eventId: true,
        walletAddress: true,
        expiresAt: true,
        consumedAt: true,
        proofReference: true,
      },
    });
  }

  async markProven(id: string, proofReference: string): Promise<boolean> {
    const { count } = await this.db.checkInChallenge.updateMany({
      where: { id, proofReference: null, consumedAt: null },
      data: { proofReference },
    });
    return count === 1;
  }

  async hasCheckIn(ticketId: string, eventId: string): Promise<boolean> {
    const found = await this.db.checkInRecord.findUnique({
      where: { ticketId_eventId: { ticketId, eventId } },
      select: { id: true },
    });
    return found !== null;
  }

  async admitAtomically(r: NewCheckInRecord): Promise<AdmitOutcome> {
    try {
      return await this.db.$transaction(async (tx) => {
        const { count } = await tx.checkInChallenge.updateMany({
          where: { id: r.challengeId, consumedAt: null },
          data: { consumedAt: r.scannedAt },
        });
        if (count !== 1) return "CHALLENGE_ALREADY_CONSUMED";
        await tx.checkInRecord.create({
          data: {
            ticketId: r.ticketId,
            eventId: r.eventId,
            challengeId: r.challengeId,
            organiserId: r.organiserId,
            walletAddress: r.walletAddress,
            verifiedLedgerIndex: r.verifiedLedgerIndex,
            scannedAt: r.scannedAt,
          },
        });
        return "ADMITTED";
      });
    } catch (err) {
      if (isUniqueViolation(err)) return "TICKET_ALREADY_CHECKED_IN";
      throw err;
    }
  }
}

export class PrismaTicketDirectory implements TicketDirectory {
  constructor(private readonly db: Pick<PrismaClient, "ticketNFT">) {}

  async findTicket(ticketId: string): Promise<TicketRef | null> {
    const t = await this.db.ticketNFT.findUnique({
      where: { id: ticketId },
      select: { id: true, eventId: true, nftokenId: true },
    });
    // nftokenId is only set from a validated mint (schema invariant, XRPL-005).
    return t ? { ticketId: t.id, eventId: t.eventId, nftokenId: t.nftokenId } : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}
