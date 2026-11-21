import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { FriendService } from "./friend-service";
import { PrismaFriendStore } from "./prisma-store";
import { PrismaUserDirectory } from "./user-directory";

/** XRPL-084 friendships on the real FriendConnection and UserBlock tables (`npm run test:db`). */

const db = getDb();
const service = new FriendService({ store: new PrismaFriendStore(db), users: new PrismaUserDirectory(db) });

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "UserBlock","FriendConnection","Review","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

const person = async (displayName: string) =>
  (await db.user.create({ data: { displayName, role: "CUSTOMER", onboardedAt: new Date() } })).id;

describe("friendships in the database", () => {
  it("sends, accepts and removes a friend request", async () => {
    const [aoife, ben] = [await person("Aoife"), await person("Ben")];

    expect(await service.sendRequest(aoife, ben)).toMatchObject({ status: "PENDING" });
    const incoming = (await service.overview(ben)).incoming;
    expect(incoming).toHaveLength(1);
    expect(await service.areFriends(aoife, ben)).toBe(false);

    expect(await service.respond(ben, incoming[0]!.requestId, true)).toMatchObject({ status: "ACCEPTED" });
    expect(await service.areFriends(aoife, ben)).toBe(true);
    expect(await service.listFriendIds(ben)).toEqual([aoife]);

    await service.remove(aoife, ben);
    expect(await service.areFriends(aoife, ben)).toBe(false);
    expect(await db.friendConnection.count()).toBe(0);
  });

  it("declines a request by deleting it", async () => {
    const [aoife, ben] = [await person("Aoife"), await person("Ben")];
    await service.sendRequest(aoife, ben);
    const request = (await service.overview(ben)).incoming[0]!;

    await service.respond(ben, request.requestId, false);
    expect(await db.friendConnection.count()).toBe(0);
    expect((await service.overview(aoife)).outgoing).toEqual([]);
  });

  it("keeps one connection per pair, even when both people ask at once", async () => {
    const [aoife, ben] = [await person("Aoife"), await person("Ben")];

    const results = await Promise.allSettled([service.sendRequest(aoife, ben), service.sendRequest(ben, aoife)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await db.friendConnection.count()).toBe(1);
    // Asking someone who asked you makes you friends.
    expect(await service.areFriends(aoife, ben)).toBe(true);
  });

  it("blocking ends the friendship and stops requests in both directions; unblocking doesn't restore it", async () => {
    const [aoife, ben] = [await person("Aoife"), await person("Ben")];
    await service.sendRequest(aoife, ben);
    await service.respond(ben, (await service.overview(ben)).incoming[0]!.requestId, true);

    await service.block(ben, aoife);
    await service.block(ben, aoife); // safe to repeat
    expect(await service.areFriends(aoife, ben)).toBe(false);
    expect(await db.friendConnection.count()).toBe(0);
    expect(await db.userBlock.count()).toBe(1);
    await expect(service.sendRequest(aoife, ben)).rejects.toMatchObject({ status: 403 });
    await expect(service.sendRequest(ben, aoife)).rejects.toMatchObject({ status: 403 });

    await service.unblock(ben, aoife);
    expect(await service.areFriends(aoife, ben)).toBe(false);
    expect(await service.sendRequest(aoife, ben)).toMatchObject({ status: "PENDING" });
  });

  it("shows a friend list to friends only when its owner opted in", async () => {
    const [aoife, ben, cara] = [await person("Aoife"), await person("Ben"), await person("Cara")];
    await service.sendRequest(aoife, ben);
    await service.respond(ben, (await service.overview(ben)).incoming[0]!.requestId, true);

    expect(await service.friendsOf(ben, aoife)).toMatchObject({ visible: false });
    await service.setFriendsVisibility(aoife, "FRIENDS");
    expect(await service.friendsOf(ben, aoife)).toMatchObject({ visible: true });
    expect(await service.friendsOf(cara, aoife)).toMatchObject({ visible: false }); // not a friend
    expect(await service.friendsOf(null, aoife)).toMatchObject({ visible: false }); // not signed in
  });
});
