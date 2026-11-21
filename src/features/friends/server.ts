/**
 * Server wiring for friendships (XRPL-084). Server-only.
 * Users and privacy preferences use the existing User table. Friendship storage waits on Agent A's
 * FriendConnection / UserBlock tables (schema request in the XRPL-084 PR): until then every
 * friendship read and write answers 503 rather than pretending.
 */
import { getDb } from "@/lib/db/client";
import { errors } from "@/lib/http/response";
import { FriendService, type FriendStore } from "./friend-service";
import { PrismaUserDirectory } from "./user-directory";

const pending = async (): Promise<never> => {
  throw errors.unavailable("Friends aren't available yet.");
};

/** Placeholder until the friendship tables land; swap for a Prisma store then. */
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
  g.__friendService ??= new FriendService({ store: unavailableFriendStore, users: new PrismaUserDirectory(getDb()) });
  return g.__friendService;
}

/** Tests only. */
export function setFriendServiceForTests(service: FriendService | null): void {
  g.__friendService = service;
}
