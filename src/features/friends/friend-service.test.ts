// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/http/response";
import { FriendService } from "./friend-service";
import { FakeDirectory, InMemoryFriendStore } from "./testing/fakes";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOBODY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let store: InMemoryFriendStore;
let users: FakeDirectory;
let svc: FriendService;

const code = (p: Promise<unknown>) =>
  p.then(() => "OK", (e: unknown) => (e instanceof AppError ? `${e.status} ${e.code}` : String(e)));

async function befriend(x: string, y: string) {
  const sent = await svc.sendRequest(x, y);
  if (sent.status !== "PENDING") throw new Error("expected pending");
  await svc.respond(y, sent.requestId, true);
}

beforeEach(() => {
  store = new InMemoryFriendStore();
  users = new FakeDirectory();
  users.add(A, "Aoife");
  users.add(B, "Brian");
  users.add(C, "Cara");
  svc = new FriendService({ store, users, clock: { now: () => new Date("2026-12-01T12:00:00Z") } });
});

describe("XRPL-084 friend requests", () => {
  it("send, then accept: both see each other as friends", async () => {
    const sent = await svc.sendRequest(A, B);
    expect(sent).toMatchObject({ status: "PENDING" });
    expect((await svc.overview(A)).outgoing.map((r) => r.displayName)).toEqual(["Brian"]);
    const incoming = (await svc.overview(B)).incoming;
    expect(incoming.map((r) => r.displayName)).toEqual(["Aoife"]);

    expect(await svc.respond(B, incoming[0]!.requestId, true)).toMatchObject({ status: "ACCEPTED" });
    expect((await svc.overview(A)).friends).toEqual([{ userId: B, displayName: "Brian", since: "2026-12-01T12:00:00.000Z" }]);
    expect((await svc.overview(B)).friends.map((f) => f.userId)).toEqual([A]);
    expect(await svc.areFriends(A, B)).toBe(true);
    expect(await svc.listFriendIds(A)).toEqual([B]);
  });

  it("decline removes the request", async () => {
    const sent = await svc.sendRequest(A, B);
    if (sent.status !== "PENDING") throw new Error();
    expect(await svc.respond(B, sent.requestId, false)).toEqual({ status: "DECLINED" });
    expect((await svc.overview(A)).outgoing).toEqual([]);
    expect(await svc.areFriends(A, B)).toBe(false);
  });

  it("asking someone who already asked you makes you friends", async () => {
    await svc.sendRequest(A, B);
    expect(await svc.sendRequest(B, A)).toMatchObject({ status: "ACCEPTED" });
    expect(await svc.areFriends(A, B)).toBe(true);
    expect(store.connections.size).toBe(1);
  });

  it("two people asking each other at the same moment end up friends, stored once", async () => {
    const results = await Promise.all([svc.sendRequest(A, B), svc.sendRequest(B, A)]);
    expect(results.map((r) => r.status).sort()).toEqual(["ACCEPTED", "PENDING"]);
    expect(store.connections.size).toBe(1);
    expect(await svc.areFriends(A, B)).toBe(true);
  });

  it("refuses yourself, unknown codes, duplicates and existing friends", async () => {
    expect(await code(svc.sendRequest(A, A))).toBe("400 CANNOT_FRIEND_SELF");
    expect(await code(svc.sendRequest(A, NOBODY))).toBe("404 USER_NOT_FOUND");
    await svc.sendRequest(A, B);
    expect(await code(svc.sendRequest(A, B))).toBe("409 REQUEST_PENDING");
    await befriend(A, C);
    expect(await code(svc.sendRequest(C, A))).toBe("409 ALREADY_FRIENDS");
  });

  it("only the person a request was sent to can answer it", async () => {
    const sent = await svc.sendRequest(A, B);
    if (sent.status !== "PENDING") throw new Error();
    expect(await code(svc.respond(A, sent.requestId, true))).toBe("404 REQUEST_NOT_FOUND");
    expect(await code(svc.respond(C, sent.requestId, true))).toBe("404 REQUEST_NOT_FOUND");
    expect(await code(svc.respond(B, "no-such-request", true))).toBe("404 REQUEST_NOT_FOUND");
  });

  it("removing a friend revokes access straight away; cancel works the same way", async () => {
    await befriend(A, B);
    await svc.remove(A, B);
    expect(await svc.areFriends(A, B)).toBe(false);
    expect(await svc.listFriendIds(B)).toEqual([]);
    expect(await code(svc.remove(A, B))).toBe("404 NOT_CONNECTED");

    await svc.sendRequest(A, C);
    await svc.remove(A, C); // cancel own request
    expect((await svc.overview(C)).incoming).toEqual([]);
  });
});

describe("XRPL-084 blocking", () => {
  it("removes the friendship, stops requests both ways and doesn't come back on unblock", async () => {
    await befriend(A, B);
    await svc.block(A, B);
    expect(await svc.areFriends(A, B)).toBe(false);
    expect((await svc.overview(A)).blocked).toEqual([{ userId: B, displayName: "Brian" }]);
    expect(await code(svc.sendRequest(B, A))).toBe("403 FRIEND_REQUEST_NOT_ALLOWED");
    expect(await code(svc.sendRequest(A, B))).toBe("403 FRIEND_REQUEST_NOT_ALLOWED");

    await svc.unblock(A, B);
    expect(await svc.areFriends(A, B)).toBe(false);
    expect(await svc.sendRequest(B, A)).toMatchObject({ status: "PENDING" });
  });

  it("a pending request from a blocked person can't be accepted", async () => {
    const sent = await svc.sendRequest(B, A);
    if (sent.status !== "PENDING") throw new Error();
    store.blocks.add(`${A}|${B}`); // block recorded without clearing, e.g. by another path
    expect(await code(svc.respond(A, sent.requestId, true))).toBe("404 REQUEST_NOT_FOUND");
  });

  it("can't block yourself or an unknown code", async () => {
    expect(await code(svc.block(A, A))).toBe("400 CANNOT_FRIEND_SELF");
    expect(await code(svc.block(A, NOBODY))).toBe("404 USER_NOT_FOUND");
  });
});

describe("XRPL-084 friend list visibility", () => {
  beforeEach(async () => {
    await befriend(A, B);
    await befriend(A, C);
  });

  it("is private by default: only the owner sees it", async () => {
    expect(await svc.friendsOf(A, A)).toMatchObject({ visible: true });
    expect((await svc.friendsOf(A, A)).friends.map((f) => f.displayName)).toEqual(["Brian", "Cara"]);
    expect(await svc.friendsOf(B, A)).toEqual({ userId: A, visible: false, friends: [] });
    expect(await svc.friendsOf(null, A)).toEqual({ userId: A, visible: false, friends: [] });
  });

  it("friends can see it once the owner opts in, strangers still can't", async () => {
    await svc.setFriendsVisibility(A, "FRIENDS");
    expect(await svc.friendsOf(B, A)).toMatchObject({ visible: true });
    users.add("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "Eve");
    expect(await svc.friendsOf("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", A)).toMatchObject({ visible: false });
  });

  it("a private profile never shows it, and removal revokes it", async () => {
    await svc.setFriendsVisibility(A, "FRIENDS");
    users.users.get(A)!.profileVisibility = "PRIVATE";
    expect(await svc.friendsOf(B, A)).toMatchObject({ visible: false });

    users.users.get(A)!.profileVisibility = "PUBLIC";
    await svc.remove(A, B);
    expect(await svc.friendsOf(B, A)).toMatchObject({ visible: false });
  });

  it("404 for an unknown user", async () => {
    expect(await code(svc.friendsOf(A, NOBODY))).toBe("404 USER_NOT_FOUND");
  });
});
