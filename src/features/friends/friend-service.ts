/**
 * Mutual friend connections (XRPL-084).
 *
 * - A pair of people is stored once, lower account ID first, so "A asked B" and "B asked A" can't
 *   both exist. If you ask someone who already asked you, you simply become friends.
 * - Decline and remove delete the connection. Block deletes it too and stops requests in both
 *   directions, without telling the other person why.
 * - `areFriends` / `listFriendIds` are what shared-activity features (XRPL-085/086) must use, so
 *   removing or blocking someone revokes their access to anything shared later.
 * - Friend lists are private by default: visible to their owner, and to the owner's friends only if
 *   the owner opted in and their profile is public.
 */
import type { FriendRequestResult, FriendsOf, FriendsOverview, FriendsVisibility } from "@/contracts/friends";
import type { ProfileVisibility } from "@/contracts";
import { AppError } from "@/lib/http/response";

export type ConnectionStatus = "PENDING" | "ACCEPTED";

export type StoredConnection = {
  id: string;
  userLowId: string;
  userHighId: string;
  requestedById: string;
  status: ConnectionStatus;
  createdAt: Date;
  respondedAt: Date | null;
};

/** Friendship storage: `PrismaFriendStore` on Agent A's FriendConnection / UserBlock tables. */
export interface FriendStore {
  findPair(userLowId: string, userHighId: string): Promise<StoredConnection | null>;
  findById(id: string): Promise<StoredConnection | null>;
  /** Throws a unique-violation error (code P2002) if the pair already exists. */
  createPending(userLowId: string, userHighId: string, requestedById: string): Promise<StoredConnection>;
  /** Conditional: only a PENDING connection becomes ACCEPTED. False otherwise. */
  acceptPending(id: string, at: Date): Promise<boolean>;
  remove(id: string): Promise<void>;
  listForUser(userId: string): Promise<StoredConnection[]>;
  /** True if either person blocked the other. */
  isBlocked(a: string, b: string): Promise<boolean>;
  /** Idempotent. Also deletes any connection between the two, in one transaction. */
  block(blockerId: string, blockedId: string): Promise<void>;
  unblock(blockerId: string, blockedId: string): Promise<boolean>;
  listBlockedBy(blockerId: string): Promise<string[]>;
}

export type DirectoryUser = { displayName: string; profileVisibility: ProfileVisibility; friendsVisibility: FriendsVisibility };

/** Users and their privacy preferences (User table, available now). */
export interface UserDirectory {
  getUsers(ids: readonly string[]): Promise<Map<string, DirectoryUser>>;
  setFriendsVisibility(userId: string, value: FriendsVisibility): Promise<void>;
}

export interface Clock {
  now(): Date;
}

const pairOf = (a: string, b: string): [string, string] => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);
const otherOf = (c: StoredConnection, me: string) => (c.userLowId === me ? c.userHighId : c.userLowId);
const involves = (c: StoredConnection, me: string) => c.userLowId === me || c.userHighId === me;

const err = {
  self: () => new AppError("CANNOT_FRIEND_SELF", "You can't send a friend request to yourself.", 400),
  userNotFound: () => new AppError("USER_NOT_FOUND", "No one has that friend code.", 404),
  notAllowed: () => new AppError("FRIEND_REQUEST_NOT_ALLOWED", "You can't send a friend request to this person.", 403),
  alreadyFriends: () => new AppError("ALREADY_FRIENDS", "You're already friends.", 409),
  pending: () => new AppError("REQUEST_PENDING", "You've already sent this person a request.", 409),
  requestNotFound: () => new AppError("REQUEST_NOT_FOUND", "That friend request no longer exists.", 404),
  notConnected: () => new AppError("NOT_CONNECTED", "You're not connected with this person.", 404),
};

export class FriendService {
  private readonly clock: Clock;

  constructor(private readonly deps: { store: FriendStore; users: UserDirectory; clock?: Clock }) {
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  async overview(me: string): Promise<FriendsOverview> {
    const [connections, blockedIds] = await Promise.all([
      this.deps.store.listForUser(me),
      this.deps.store.listBlockedBy(me),
    ]);
    const others = connections.map((c) => otherOf(c, me));
    const users = await this.deps.users.getUsers([me, ...others, ...blockedIds]);
    const name = (id: string) => users.get(id)?.displayName ?? "Unknown";

    const overview: FriendsOverview = {
      myCode: me,
      friends: [],
      incoming: [],
      outgoing: [],
      blocked: blockedIds.map((id) => ({ userId: id, displayName: name(id) })),
      friendsVisibility: users.get(me)?.friendsVisibility ?? "ONLY_ME",
    };
    for (const c of connections) {
      const other = otherOf(c, me);
      if (c.status === "ACCEPTED") {
        overview.friends.push({ userId: other, displayName: name(other), since: (c.respondedAt ?? c.createdAt).toISOString() });
      } else {
        const view = { requestId: c.id, userId: other, displayName: name(other), sentAt: c.createdAt.toISOString() };
        (c.requestedById === me ? overview.outgoing : overview.incoming).push(view);
      }
    }
    overview.friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return overview;
  }

  async sendRequest(me: string, target: string): Promise<FriendRequestResult> {
    if (me === target) throw err.self();
    const users = await this.deps.users.getUsers([target]);
    if (!users.has(target)) throw err.userNotFound();
    if (await this.deps.store.isBlocked(me, target)) throw err.notAllowed();

    const [low, high] = pairOf(me, target);
    const existing = await this.deps.store.findPair(low, high);
    if (existing) return this.resolveExisting(existing, me);
    try {
      const created = await this.deps.store.createPending(low, high, me);
      return { status: "PENDING", requestId: created.id };
    } catch (error) {
      if ((error as { code?: unknown }).code !== "P2002") throw error;
      // Both people asked at the same moment: the other request won the insert.
      const raced = await this.deps.store.findPair(low, high);
      if (!raced) throw error;
      return this.resolveExisting(raced, me);
    }
  }

  async respond(me: string, requestId: string, accept: boolean): Promise<FriendRequestResult> {
    const c = await this.deps.store.findById(requestId);
    // Only the person a pending request was sent to can answer it.
    if (!c || c.status !== "PENDING" || !involves(c, me) || c.requestedById === me) throw err.requestNotFound();
    if (!accept) {
      await this.deps.store.remove(c.id);
      return { status: "DECLINED" };
    }
    if (await this.deps.store.isBlocked(c.userLowId, c.userHighId)) throw err.requestNotFound();
    if (!(await this.deps.store.acceptPending(c.id, this.clock.now()))) throw err.requestNotFound();
    return { status: "ACCEPTED", requestId: c.id };
  }

  /** Unfriend, cancel your own request, or decline theirs. */
  async remove(me: string, other: string): Promise<void> {
    const [low, high] = pairOf(me, other);
    const c = await this.deps.store.findPair(low, high);
    if (!c) throw err.notConnected();
    await this.deps.store.remove(c.id);
  }

  async block(me: string, other: string): Promise<void> {
    if (me === other) throw err.self();
    const users = await this.deps.users.getUsers([other]);
    if (!users.has(other)) throw err.userNotFound();
    await this.deps.store.block(me, other);
  }

  async unblock(me: string, other: string): Promise<void> {
    await this.deps.store.unblock(me, other);
  }

  async setFriendsVisibility(me: string, value: FriendsVisibility): Promise<void> {
    await this.deps.users.setFriendsVisibility(me, value);
  }

  /** Accepted, and neither has blocked the other. The check shared-activity features must use. */
  async areFriends(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    const [low, high] = pairOf(a, b);
    const c = await this.deps.store.findPair(low, high);
    return !!c && c.status === "ACCEPTED" && !(await this.deps.store.isBlocked(a, b));
  }

  /** IDs of accepted friends, excluding anyone blocked in either direction. */
  async listFriendIds(userId: string): Promise<string[]> {
    const accepted = (await this.deps.store.listForUser(userId)).filter((c) => c.status === "ACCEPTED");
    const ids: string[] = [];
    for (const c of accepted) {
      const other = otherOf(c, userId);
      if (!(await this.deps.store.isBlocked(userId, other))) ids.push(other);
    }
    return ids;
  }

  /** Someone's friend list, only where their privacy settings allow this viewer to see it. */
  async friendsOf(viewer: string | null, target: string): Promise<FriendsOf> {
    const users = await this.deps.users.getUsers([target]);
    const owner = users.get(target);
    if (!owner) throw err.userNotFound();
    const hidden: FriendsOf = { userId: target, visible: false, friends: [] };

    if (viewer !== target) {
      if (!viewer || owner.profileVisibility === "PRIVATE" || owner.friendsVisibility !== "FRIENDS") return hidden;
      if (!(await this.areFriends(viewer, target))) return hidden;
    }
    const { friends } = await this.overview(target);
    return { userId: target, visible: true, friends };
  }

  private async resolveExisting(c: StoredConnection, me: string): Promise<FriendRequestResult> {
    if (c.status === "ACCEPTED") throw err.alreadyFriends();
    if (c.requestedById === me) throw err.pending();
    // They had already asked you: asking back means you're both in.
    if (!(await this.deps.store.acceptPending(c.id, this.clock.now()))) throw err.alreadyFriends();
    return { status: "ACCEPTED", requestId: c.id };
  }
}
