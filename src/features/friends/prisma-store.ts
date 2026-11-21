/**
 * Friendship storage on Agent A's FriendConnection and UserBlock tables (XRPL-084). Server-only.
 *
 * The tables enforce what the service relies on: one row per pair (unique on the ordered pair), and one
 * block per direction (the primary key). The conditional updates here keep concurrent answers safe.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { FriendStore, StoredConnection } from "./friend-service";

type Db = Pick<PrismaClient, "friendConnection" | "userBlock" | "$transaction">;

export class PrismaFriendStore implements FriendStore {
  constructor(private readonly db: Db) {}

  findPair(userLowId: string, userHighId: string): Promise<StoredConnection | null> {
    return this.db.friendConnection.findUnique({ where: { userLowId_userHighId: { userLowId, userHighId } } });
  }

  findById(id: string): Promise<StoredConnection | null> {
    return this.db.friendConnection.findUnique({ where: { id } });
  }

  /** The unique index on the pair makes a second request for the same two people fail with P2002. */
  createPending(userLowId: string, userHighId: string, requestedById: string): Promise<StoredConnection> {
    return this.db.friendConnection.create({ data: { userLowId, userHighId, requestedById, status: "PENDING" } });
  }

  async acceptPending(id: string, at: Date): Promise<boolean> {
    const updated = await this.db.friendConnection.updateMany({
      where: { id, status: "PENDING" },
      data: { status: "ACCEPTED", respondedAt: at },
    });
    return updated.count === 1;
  }

  async remove(id: string): Promise<void> {
    await this.db.friendConnection.deleteMany({ where: { id } });
  }

  listForUser(userId: string): Promise<StoredConnection[]> {
    return this.db.friendConnection.findMany({
      where: { OR: [{ userLowId: userId }, { userHighId: userId }] },
      orderBy: { createdAt: "asc" },
    });
  }

  async isBlocked(a: string, b: string): Promise<boolean> {
    const blocks = await this.db.userBlock.count({
      where: {
        OR: [
          { blockerId: a, blockedId: b },
          { blockerId: b, blockedId: a },
        ],
      },
    });
    return blocks > 0;
  }

  /** Records the block and deletes any connection between the two, together. Safe to repeat. */
  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.db.$transaction([
      this.db.userBlock.upsert({
        where: { blockerId_blockedId: { blockerId, blockedId } },
        create: { blockerId, blockedId },
        update: {},
      }),
      this.db.friendConnection.deleteMany({
        where: {
          OR: [
            { userLowId: blockerId, userHighId: blockedId },
            { userLowId: blockedId, userHighId: blockerId },
          ],
        },
      }),
    ]);
  }

  async unblock(blockerId: string, blockedId: string): Promise<boolean> {
    const removed = await this.db.userBlock.deleteMany({ where: { blockerId, blockedId } });
    return removed.count > 0;
  }

  async listBlockedBy(blockerId: string): Promise<string[]> {
    const rows = await this.db.userBlock.findMany({
      where: { blockerId },
      select: { blockedId: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => row.blockedId);
  }
}
