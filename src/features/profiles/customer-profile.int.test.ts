import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { getOwnCustomerProfile, updateOwnCustomerProfile } from "./customer-profile";
import { ProfileNotFoundError } from "./profile-store";

/** XRPL-056 profile edits against Postgres (`npm run test:db`). */

const db = getDb();

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Review","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

describe("customer profile (XRPL-056)", () => {
  it("edits the display name and avatar, keeping other preferences", async () => {
    const user = await db.user.create({
      data: { displayName: "Aoife", role: "CUSTOMER", settings: { city: "Dublin", interests: ["MUSIC"], uiTheme: "dark" } },
    });

    const updated = await updateOwnCustomerProfile(db, user.id, {
      displayName: "Aoife M",
      imageUrl: "https://img.example/a.png",
    });
    expect(updated).toMatchObject({ displayName: "Aoife M", imageUrl: "https://img.example/a.png", role: "CUSTOMER" });

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.displayName).toBe("Aoife M");
    // City, interests and unrelated keys survive the write.
    expect(row.settings).toMatchObject({ city: "Dublin", interests: ["MUSIC"], uiTheme: "dark", imageUrl: "https://img.example/a.png" });
  });

  it("an empty avatar link removes it; a name-only edit leaves the avatar alone", async () => {
    const user = await db.user.create({ data: { displayName: "Aoife", role: "CUSTOMER" } });
    await updateOwnCustomerProfile(db, user.id, { imageUrl: "https://img.example/a.png" });
    expect((await updateOwnCustomerProfile(db, user.id, { displayName: "Aoife M" })).imageUrl).toBe("https://img.example/a.png");
    expect((await updateOwnCustomerProfile(db, user.id, { imageUrl: "" })).imageUrl).toBeNull();
  });

  it("never returns an unsafe stored link", async () => {
    const user = await db.user.create({ data: { displayName: "Aoife", role: "CUSTOMER", settings: { imageUrl: "javascript:alert(1)" } } });
    expect((await getOwnCustomerProfile(db, user.id)).imageUrl).toBeNull();
  });

  it("reports a missing profile", async () => {
    await expect(getOwnCustomerProfile(db, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ProfileNotFoundError);
    await expect(updateOwnCustomerProfile(db, "00000000-0000-4000-8000-000000000000", { displayName: "X Y" })).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
  });
});
