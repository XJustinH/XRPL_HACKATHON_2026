/**
 * Server wiring for friendships (XRPL-084). Server-only.
 * Users and privacy preferences use the User table, and friendships Agent A's FriendConnection and
 * UserBlock tables (`PrismaFriendStore`).
 */
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { FriendService, type FriendStore } from "./friend-service";
import { PrismaFriendStore } from "./prisma-store";
import { PrismaUserDirectory } from "./user-directory";

const pending = async (): Promise<never> => {
  throw errors.unavailable("Friends aren't available yet.");
};

/** Answers 503 for everything. Kept to switch friendships off quickly if ever needed. */
export const unavailableFriendStore: FriendStore = {
  findPair: pending,
  findById: pending,
  createPending: pending,
  acceptPending: pending,
  remove: pending,
  listForUser: pending,
  isBlocked: pending,
  block: pending,
  unblock: pending,
  listBlockedBy: pending,
};

const g = globalThis as unknown as { __friendService?: FriendService | null };

export function getFriendService(): FriendService {
  const db = getDb();
  g.__friendService ??= new FriendService({ store: new PrismaFriendStore(db), users: new PrismaUserDirectory(db) });
  return g.__friendService;
}

/** Tests only. */
export function setFriendServiceForTests(service: FriendService | null): void {
  g.__friendService = service;
}
