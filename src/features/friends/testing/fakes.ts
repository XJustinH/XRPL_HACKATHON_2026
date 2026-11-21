/** In-memory stand-ins for friendships. Test use only. Same semantics as the planned Prisma store. */
import { randomUUID } from "node:crypto";
import type { FriendsVisibility } from "@/contracts/friends";
import type { DirectoryUser, FriendStore, StoredConnection, UserDirectory } from "../friend-service";

export class InMemoryFriendStore implements FriendStore {
  readonly connections = new Map<string, StoredConnection>();
  readonly blocks = new Set<string>(); // `${blocker}|${blocked}`
  private seq = 0;

  /** Synchronous, so check-and-insert in createPending is atomic like a unique index. */
  private pair(low: string, high: string) {
    return [...this.connections.values()].find((c) => c.userLowId === low && c.userHighId === high) ?? null;
  }
  async findPair(low: string, high: string) {
    return this.pair(low, high);
  }
  async findById(id: string) {
    return this.connections.get(id) ?? null;
  }
  async createPending(low: string, high: string, requestedById: string) {
    if (this.pair(low, high)) throw Object.assign(new Error("unique"), { code: "P2002" });
    const c: StoredConnection = {
      id: randomUUID(),
      userLowId: low,
      userHighId: high,
      requestedById,
      status: "PENDING",
      createdAt: new Date(Date.UTC(2026, 11, 1, 10, ++this.seq)),
      respondedAt: null,
    };
    this.connections.set(c.id, c);
    return c;
  }
  async acceptPending(id: string, at: Date) {
    const c = this.connections.get(id);
    if (!c || c.status !== "PENDING") return false;
    c.status = "ACCEPTED";
    c.respondedAt = at;
    return true;
  }
  async remove(id: string) {
    this.connections.delete(id);
  }
  async listForUser(userId: string) {
    return [...this.connections.values()].filter((c) => c.userLowId === userId || c.userHighId === userId);
  }
  async isBlocked(a: string, b: string) {
    return this.blocks.has(`${a}|${b}`) || this.blocks.has(`${b}|${a}`);
  }
  async block(blocker: string, blocked: string) {
    this.blocks.add(`${blocker}|${blocked}`);
    for (const c of await this.listForUser(blocker)) {
      if (c.userLowId === blocked || c.userHighId === blocked) this.connections.delete(c.id);
    }
  }
  async unblock(blocker: string, blocked: string) {
    return this.blocks.delete(`${blocker}|${blocked}`);
  }
  async listBlockedBy(blocker: string) {
    return [...this.blocks].filter((k) => k.startsWith(`${blocker}|`)).map((k) => k.split("|")[1]!);
  }
}

export class FakeDirectory implements UserDirectory {
  readonly users = new Map<string, DirectoryUser>();
  add(id: string, displayName: string, over: Partial<DirectoryUser> = {}) {
    this.users.set(id, { displayName, profileVisibility: "PUBLIC", friendsVisibility: "ONLY_ME", ...over });
  }
  async getUsers(ids: readonly string[]) {
    return new Map(ids.filter((id) => this.users.has(id)).map((id) => [id, this.users.get(id)!]));
  }
  async setFriendsVisibility(userId: string, value: FriendsVisibility) {
    const u = this.users.get(userId);
    if (u) u.friendsVisibility = value;
  }
}
