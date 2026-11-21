/**
 * Agent D contract slice: mutual friend connections (XRPL-084).
 * Friendships are opt-in and private by default (handoff §2.2: P2 community features default to
 * opt-in visibility). Ask Agent A to export this slice from `src/contracts/index.ts`.
 */
import { z } from "zod";
import { AppId, type IsoDateTime } from "./common";

/** Who may see your friend list. Default ONLY_ME; a private profile never shows it. */
export const FriendsVisibility = z.enum(["ONLY_ME", "FRIENDS"]);
export type FriendsVisibility = z.infer<typeof FriendsVisibility>;

/** POST /api/friends/requests: the other person's friend code (their account ID). */
export const FriendRequestInput = z.object({ userId: AppId });
/** POST /api/friends/requests/:id/respond */
export const FriendResponseInput = z.object({ accept: z.boolean() });
/** POST /api/friends/blocks */
export const BlockInput = z.object({ userId: AppId });
/** PATCH /api/friends/settings */
export const FriendsSettingsInput = z.object({ friendsVisibility: FriendsVisibility });

export type FriendSummary = { userId: string; displayName: string; since: IsoDateTime };
export type FriendRequestView = { requestId: string; userId: string; displayName: string; sentAt: IsoDateTime };

/** GET /api/friends: the caller's own friends, requests and blocks. */
export type FriendsOverview = {
  /** Share this so someone can send you a request. */
  myCode: string;
  friends: FriendSummary[];
  /** Requests waiting for you. */
  incoming: FriendRequestView[];
  /** Requests you sent that are still waiting. */
  outgoing: FriendRequestView[];
  blocked: { userId: string; displayName: string }[];
  friendsVisibility: FriendsVisibility;
};

/** Result of sending or answering a request. ACCEPTED when both people had asked. */
export type FriendRequestResult = { status: "PENDING" | "ACCEPTED"; requestId: string } | { status: "DECLINED" };

/** GET /api/users/:id/friends: someone's friend list, only if they allow you to see it. */
export type FriendsOf = { userId: string; visible: boolean; friends: FriendSummary[] };
