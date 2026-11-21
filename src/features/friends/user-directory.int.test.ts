import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { PrismaUserDirectory } from "./user-directory";

/** XRPL-084 users and privacy preferences on the real User table (`npm run test:db`). */

const db = getDb();
const directory = new PrismaUserDirectory(db);

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Review","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

describe("PrismaUserDirectory", () => {
  it("defaults to a private friend list and a public profile", async () => {
    const u = await db.user.create({ data: { displayName: "Aoife", role: "CUSTOMER" } });
    expect((await directory.getUsers([u.id])).get(u.id)).toEqual({
      displayName: "Aoife",
      profileVisibility: "PUBLIC",
      friendsVisibility: "ONLY_ME",
    });
  });

  it("reads profile privacy and ignores unknown stored values", async () => {
    const u = await db.user.create({
      data: { displayName: "Brian", role: "CUSTOMER", settings: { visibility: "PRIVATE", friendsVisibility: "EVERYONE" } },
    });
    expect((await directory.getUsers([u.id])).get(u.id)).toMatchObject({ profileVisibility: "PRIVATE", friendsVisibility: "ONLY_ME" });
  });

  it("saves the friend list setting without touching other preferences", async () => {
    const u = await db.user.create({ data: { displayName: "Cara", role: "CUSTOMER", settings: { city: "Cork", interests: ["MUSIC"] } } });
    await directory.setFriendsVisibility(u.id, "FRIENDS");
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.settings).toEqual({ city: "Cork", interests: ["MUSIC"], friendsVisibility: "FRIENDS" });
    expect((await directory.getUsers([u.id])).get(u.id)?.friendsVisibility).toBe("FRIENDS");
  });

  it("returns only users that exist, once each", async () => {
    const u = await db.user.create({ data: { displayName: "Dan", role: "CUSTOMER" } });
    const found = await directory.getUsers([u.id, u.id, "00000000-0000-4000-8000-000000000000"]);
    expect([...found.keys()]).toEqual([u.id]);
    expect((await directory.getUsers([])).size).toBe(0);
  });
});
