import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "./client";

/**
 * Schema invariants for XRPL-005, run against a real Postgres (`npm run test:db`).
 * The test database is reset by test-global-setup.ts before the run.
 */

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set");
const db = createPrismaClient(url);

const NFT_A = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA200000001";
const NFT_B = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C00000BA200000002";
const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");
const ADDR = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

async function seedEvent() {
  const seller = await db.user.create({ data: { displayName: "Seller", role: "SELLER" } });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Testnet Gig",
      startsAt: new Date("2026-12-01T20:00:00Z"),
      venue: "Vicar St",
      city: "Dublin",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 2 },
  });
  return { seller, event, tier };
}

async function mintedTicket(eventId: string, tierId: string, serial: number, nftokenId: string) {
  return db.ticketNFT.create({
    data: {
      eventId,
      tierId,
      serial,
      nftokenId,
      mintStatus: "MINTED",
      mintTxHash: TX(serial + 1000),
      mintedAt: new Date(),
    },
  });
}

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});

afterAll(async () => {
  await db.$disconnect();
});

describe("ledger identity", () => {
  it("rejects a duplicate on-chain NFTokenID", async () => {
    const { event, tier } = await seedEvent();
    await mintedTicket(event.id, tier.id, 1, NFT_A);
    await expect(mintedTicket(event.id, tier.id, 2, NFT_A)).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows many unminted tickets (nftokenId null)", async () => {
    const { event, tier } = await seedEvent();
    await db.ticketNFT.createMany({
      data: [
        { eventId: event.id, tierId: tier.id, serial: 1 },
        { eventId: event.id, tierId: tier.id, serial: 2 },
      ],
    });
    expect(await db.ticketNFT.count()).toBe(2);
  });

  it("rejects a MINTED ticket without its ledger identity", async () => {
    const { event, tier } = await seedEvent();
    await expect(
      db.ticketNFT.create({ data: { eventId: event.id, tierId: tier.id, serial: 1, mintStatus: "MINTED" } }),
    ).rejects.toThrow(/TicketNFT_minted_has_identity/);
  });

  it("rejects a duplicate serial within a tier", async () => {
    const { event, tier } = await seedEvent();
    await db.ticketNFT.create({ data: { eventId: event.id, tierId: tier.id, serial: 1 } });
    await expect(db.ticketNFT.create({ data: { eventId: event.id, tierId: tier.id, serial: 1 } })).rejects.toMatchObject(
      { code: "P2002" },
    );
  });

  it("records ledger transactions uniquely by hash", async () => {
    await db.ledgerTransaction.create({ data: { hash: TX(1), type: "NFTokenMint" } });
    await expect(db.ledgerTransaction.create({ data: { hash: TX(1), type: "NFTokenMint" } })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});

describe("check-in uniqueness", () => {
  it("admits a ticket to an event only once", async () => {
    const { seller, event, tier } = await seedEvent();
    const ticket = await mintedTicket(event.id, tier.id, 1, NFT_A);
    const data = { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: ADDR };
    await db.checkInRecord.create({ data });
    await expect(db.checkInRecord.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });

  it("lets only one of two concurrent admissions succeed", async () => {
    const { seller, event, tier } = await seedEvent();
    const ticket = await mintedTicket(event.id, tier.id, 1, NFT_A);
    const data = { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: ADDR };
    const results = await Promise.allSettled([db.checkInRecord.create({ data }), db.checkInRecord.create({ data })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.checkInRecord.count()).toBe(1);
  });

  it("rejects reusing a challenge nonce", async () => {
    const { event, tier } = await seedEvent();
    const ticket = await mintedTicket(event.id, tier.id, 1, NFT_A);
    const data = {
      nonce: "nonce-1",
      ticketId: ticket.id,
      eventId: event.id,
      walletAddress: ADDR,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await db.checkInChallenge.create({ data });
    await expect(db.checkInChallenge.create({ data })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("amounts and inventory", () => {
  it.each(["1.5", "-1", "01", "1e6", ""])("rejects tier priceDrops %j", async (priceDrops) => {
    const { event } = await seedEvent();
    await expect(
      db.ticketTier.create({ data: { eventId: event.id, name: `T${priceDrops}`, priceDrops, totalSupply: 1 } }),
    ).rejects.toThrow(/TicketTier_priceDrops_format/);
  });

  it("prevents minting beyond total supply", async () => {
    const { tier } = await seedEvent();
    await expect(db.ticketTier.update({ where: { id: tier.id }, data: { mintedQuantity: 3 } })).rejects.toThrow(
      /TicketTier_supply_bounds/,
    );
  });

  it("requires gifts to be zero-price and recipient-restricted", async () => {
    const base = { nftokenId: NFT_B, ownerAddress: ADDR, kind: "GIFT" as const };
    await expect(db.nFTOffer.create({ data: { ...base, amountDrops: "1" , destinationAddress: ADDR } })).rejects.toThrow(
      /NFTOffer_gift_rules/,
    );
    await expect(db.nFTOffer.create({ data: { ...base, amountDrops: "0" } })).rejects.toThrow(/NFTOffer_gift_rules/);
    await expect(
      db.nFTOffer.create({ data: { ...base, amountDrops: "0", destinationAddress: ADDR } }),
    ).resolves.toBeTruthy();
  });

  it("requires private offers to name a destination", async () => {
    await expect(
      db.nFTOffer.create({ data: { nftokenId: NFT_B, ownerAddress: ADDR, kind: "PRIVATE", amountDrops: "10" } }),
    ).rejects.toThrow(/NFTOffer_private_rules/);
  });
});

describe("wallet links", () => {
  it("links an address to at most one user per network", async () => {
    const a = await db.user.create({ data: { displayName: "A" } });
    const b = await db.user.create({ data: { displayName: "B" } });
    await db.walletLink.create({ data: { userId: a.id, address: ADDR } });
    await expect(db.walletLink.create({ data: { userId: b.id, address: ADDR } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("defaults to unverified and Testnet", async () => {
    const u = await db.user.create({ data: { displayName: "C" } });
    const link = await db.walletLink.create({ data: { userId: u.id, address: ADDR } });
    expect(link.verifiedAt).toBeNull();
    expect(link.network).toBe("TESTNET");
  });
});

describe("event category (XRPL-015 / XRPL-059)", () => {
  it("is optional and stores the seller's choice", async () => {
    const { event, seller } = await seedEvent();
    expect(event.category).toBeNull();
    const music = await db.event.create({
      data: {
        sellerId: seller.id,
        title: "Gig",
        startsAt: new Date("2026-12-02T20:00:00Z"),
        venue: "V",
        city: "Dublin",
        category: "MUSIC",
      },
    });
    expect(music.category).toBe("MUSIC");
  });

  it.each(["", "   ", " MUSIC", "MUSIC ", "x".repeat(41)])("rejects %j (no category is NULL, values are trimmed)", async (category) => {
    const { event } = await seedEvent();
    await expect(db.event.update({ where: { id: event.id }, data: { category } })).rejects.toThrow(/Event_category_format/);
  });

  it("can filter published events by category", async () => {
    const { seller } = await seedEvent();
    const base = { sellerId: seller.id, venue: "V", city: "Dublin", startsAt: new Date("2026-12-03T20:00:00Z") };
    await db.event.createMany({
      data: [
        { ...base, title: "A", category: "MUSIC", status: "PUBLISHED" },
        { ...base, title: "B", category: "COMEDY", status: "PUBLISHED" },
        { ...base, title: "C", category: "MUSIC", status: "DRAFT" },
      ],
    });
    const found = await db.event.findMany({ where: { status: "PUBLISHED", category: "MUSIC" }, select: { title: true } });
    expect(found.map((e) => e.title)).toEqual(["A"]);
  });
});

describe("numeric tier price (XRPL-059)", () => {
  it("always equals priceDrops, on create and update, whatever the app writes", async () => {
    const { tier } = await seedEvent();
    expect(tier.priceDropsNumeric).toBe(2_500_000n);

    const repriced = await db.ticketTier.update({ where: { id: tier.id }, data: { priceDrops: "10" } });
    expect(repriced.priceDropsNumeric).toBe(10n);
    // Setting the number directly changes nothing: it follows the price.
    const ignored = await db.ticketTier.update({ where: { id: tier.id }, data: { priceDropsNumeric: 1n } });
    expect(ignored.priceDropsNumeric).toBe(10n);
    const max = "9".repeat(18); // the largest price the format CHECK allows
    expect((await db.ticketTier.update({ where: { id: tier.id }, data: { priceDrops: max } })).priceDropsNumeric).toBe(
      BigInt(max),
    );
  });

  it("filters by price as numbers, where the string comparison gets it wrong", async () => {
    const { event } = await seedEvent();
    await db.ticketTier.createMany({
      data: ["9", "10", "11", "100000000000000000"].map((priceDrops) => ({
        eventId: event.id,
        name: `P${priceDrops}`,
        priceDrops,
        totalSupply: 1,
      })),
    });
    const names = async (where: object) =>
      (await db.ticketTier.findMany({ where: { eventId: event.id, ...where }, select: { name: true } }))
        .map((t) => t.name)
        .sort();

    expect(await names({ priceDropsNumeric: { lte: 10n } })).toEqual(["P10", "P9"]);
    // Why the column exists: as strings, "9" > "10", so the cheapest tier is missed.
    expect(await names({ priceDrops: { lte: "10" } })).toEqual(["P10"]);
    const cheapest = await db.ticketTier.findFirst({ where: { eventId: event.id }, orderBy: { priceDropsNumeric: "asc" } });
    expect(cheapest?.name).toBe("P9");
  });

  it("rejects an out-of-range price with the format CHECK, not a cast error", async () => {
    const { event } = await seedEvent();
    const priceDrops = "1" + "0".repeat(18); // 19 digits: too long for the format, and for a bigint
    await expect(
      db.ticketTier.create({ data: { eventId: event.id, name: "Huge", priceDrops, totalSupply: 1 } }),
    ).rejects.toThrow(/TicketTier_priceDrops_format/);
  });

  it("rejects a number that disagrees with the price even when the trigger is bypassed", async () => {
    const { tier } = await seedEvent();
    // DDL is transactional in Postgres: the failed transaction also undoes DISABLE TRIGGER.
    const bypass = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "TicketTier" DISABLE TRIGGER "TicketTier_price_drops_numeric"`);
      await tx.$executeRawUnsafe(`UPDATE "TicketTier" SET "priceDropsNumeric" = 1 WHERE "id" = $1::uuid`, tier.id);
    });
    await expect(bypass).rejects.toThrow(/TicketTier_priceDropsNumeric_matches/);

    const after = await db.ticketTier.update({ where: { id: tier.id }, data: { priceDropsNumeric: 1n } });
    expect(after.priceDropsNumeric).toBe(2_500_000n); // the trigger is active again
  });
});

describe("reviews (XRPL-079)", () => {
  /** An event with one admitted ticket, plus the attendee who will review it. */
  async function admitted(nftokenId = NFT_A, serial = 1) {
    const { seller, event, tier } = await seedEvent();
    const ticket = await mintedTicket(event.id, tier.id, serial, nftokenId);
    const checkIn = await db.checkInRecord.create({
      data: { ticketId: ticket.id, eventId: event.id, organiserId: seller.id, walletAddress: ADDR },
    });
    const author = await db.user.create({ data: { displayName: "Fan" } });
    return { event, checkIn, author };
  }

  it("stores a review linked to the author's check-in; the body may be empty", async () => {
    const { event, checkIn, author } = await admitted();
    const review = await db.review.create({
      data: { eventId: event.id, authorId: author.id, rating: 5, checkInRecordId: checkIn.id },
    });
    expect(review).toMatchObject({ rating: 5, body: "", hiddenAt: null, checkInRecordId: checkIn.id });
  });

  it.each([0, 6, -1])("rejects rating %i", async (rating) => {
    const { event, author } = await admitted();
    await expect(db.review.create({ data: { eventId: event.id, authorId: author.id, rating } })).rejects.toThrow(
      /Review_rating_range/,
    );
  });

  it("accepts a 2000-character body and rejects 2001", async () => {
    const { event, author } = await admitted();
    await expect(
      db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 4, body: "x".repeat(2000) } }),
    ).resolves.toBeTruthy();
    const other = await db.user.create({ data: { displayName: "Other" } });
    await expect(
      db.review.create({ data: { eventId: event.id, authorId: other.id, rating: 4, body: "x".repeat(2001) } }),
    ).rejects.toThrow(/Review_body_length/);
  });

  it("allows one review per author per event", async () => {
    const { event, author } = await admitted();
    await db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 3 } });
    await expect(db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 4 } })).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("lets one check-in vouch for only one review", async () => {
    const { event, checkIn, author } = await admitted();
    await db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 5, checkInRecordId: checkIn.id } });
    const friend = await db.user.create({ data: { displayName: "Friend" } });
    await expect(
      db.review.create({ data: { eventId: event.id, authorId: friend.id, rating: 5, checkInRecordId: checkIn.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("refuses a check-in from a different event, on create and on update", async () => {
    const elsewhere = await admitted(NFT_A, 1);
    const { event, author } = await admitted(NFT_B, 2);
    await expect(
      db.review.create({
        data: { eventId: event.id, authorId: author.id, rating: 5, checkInRecordId: elsewhere.checkIn.id },
      }),
    ).rejects.toThrow(/Review_checkin_same_event/);

    const review = await db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 5 } });
    await expect(
      db.review.update({ where: { id: review.id }, data: { checkInRecordId: elsewhere.checkIn.id } }),
    ).rejects.toThrow(/Review_checkin_same_event/);
  });

  it("keeps the proof: a check-in backing a review can't be deleted", async () => {
    const { event, checkIn, author } = await admitted();
    await db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 5, checkInRecordId: checkIn.id } });
    await expect(db.checkInRecord.delete({ where: { id: checkIn.id } })).rejects.toBeTruthy();
  });

  it("removes a user's reviews with the user", async () => {
    const { event, author } = await admitted();
    await db.review.create({ data: { eventId: event.id, authorId: author.id, rating: 2 } });
    await db.user.delete({ where: { id: author.id } });
    expect(await db.review.count()).toBe(0);
  });
});

describe("friendships (XRPL-084)", () => {
  // Either side of the digit/letter boundary. The friend service orders a pair by lowercase text
  // ("9…" < "a…"), and Postgres must order the UUIDs the same way for the pair-order CHECK.
  const LOW = "9fffffff-ffff-4fff-bfff-ffffffffffff";
  const HIGH = "a0000000-0000-4000-8000-000000000000";

  async function pair() {
    const low = await db.user.create({ data: { id: LOW, displayName: "Aoife" } });
    const high = await db.user.create({ data: { id: HIGH, displayName: "Brian" } });
    return { low, high };
  }

  it("stores a pair once, lower ID first, whoever asked", async () => {
    const { low, high } = await pair();
    const request = await db.friendConnection.create({
      data: { userLowId: low.id, userHighId: high.id, requestedById: high.id },
    });
    expect(request).toMatchObject({ status: "PENDING", respondedAt: null });

    await expect(
      db.friendConnection.create({ data: { userLowId: low.id, userHighId: high.id, requestedById: low.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.friendConnection.create({ data: { userLowId: high.id, userHighId: low.id, requestedById: low.id } }),
    ).rejects.toThrow(/FriendConnection_pair_order/);
    await expect(
      db.friendConnection.create({ data: { userLowId: low.id, userHighId: low.id, requestedById: low.id } }),
    ).rejects.toThrow(/FriendConnection_pair_order/);
  });

  it("only lets one of the two people be the requester", async () => {
    const { low, high } = await pair();
    const other = await db.user.create({ data: { displayName: "Ciara" } });
    await expect(
      db.friendConnection.create({ data: { userLowId: low.id, userHighId: high.id, requestedById: other.id } }),
    ).rejects.toThrow(/FriendConnection_requester_in_pair/);
  });

  it("records when a request was accepted, and only then", async () => {
    const { low, high } = await pair();
    const { id } = await db.friendConnection.create({
      data: { userLowId: low.id, userHighId: high.id, requestedById: low.id },
    });
    await expect(db.friendConnection.update({ where: { id }, data: { status: "ACCEPTED" } })).rejects.toThrow(
      /FriendConnection_responded_when_accepted/,
    );
    await expect(db.friendConnection.update({ where: { id }, data: { respondedAt: new Date() } })).rejects.toThrow(
      /FriendConnection_responded_when_accepted/,
    );
    const accepted = await db.friendConnection.update({
      where: { id },
      data: { status: "ACCEPTED", respondedAt: new Date() },
    });
    expect(accepted.status).toBe("ACCEPTED");
  });

  it("allows one block per direction, never of yourself", async () => {
    const { low, high } = await pair();
    await db.userBlock.create({ data: { blockerId: low.id, blockedId: high.id } });
    await expect(db.userBlock.create({ data: { blockerId: low.id, blockedId: high.id } })).rejects.toMatchObject({
      code: "P2002",
    });
    await db.userBlock.create({ data: { blockerId: high.id, blockedId: low.id } });
    await expect(db.userBlock.create({ data: { blockerId: low.id, blockedId: low.id } })).rejects.toThrow(
      /UserBlock_not_self/,
    );
  });

  it("removes a user's friendships and blocks with the user", async () => {
    const { low, high } = await pair();
    await db.friendConnection.create({ data: { userLowId: low.id, userHighId: high.id, requestedById: low.id } });
    await db.userBlock.create({ data: { blockerId: high.id, blockedId: low.id } });
    await db.user.delete({ where: { id: low.id } });
    expect(await db.friendConnection.count()).toBe(0);
    expect(await db.userBlock.count()).toBe(0);
  });
});

describe("physical products (XRPL-064)", () => {
  const product = (sellerId: string, data: Record<string, unknown> = {}) =>
    db.physicalProduct.create({ data: { sellerId, name: "Tour shirt", priceDrops: "15000000", ...data } });

  it("stores a draft with no stock, images or description by default", async () => {
    const { seller } = await seedEvent();
    expect(await product(seller.id)).toMatchObject({
      status: "DRAFT",
      stock: 0,
      imageUrls: [],
      description: "",
      eventId: null,
      publishedAt: null,
    });
  });

  it.each(["0", "-1", "1.5", "01", "", "1" + "0".repeat(18)])("rejects priceDrops %j", async (priceDrops) => {
    const { seller } = await seedEvent();
    await expect(product(seller.id, { priceDrops })).rejects.toThrow(/PhysicalProduct_priceDrops_positive/);
  });

  it("never lets stock go negative", async () => {
    const { seller } = await seedEvent();
    const { id } = await product(seller.id, { stock: 2 });
    // The store's atomic adjustment: no row matches when there isn't enough stock.
    const taken = await db.physicalProduct.updateMany({
      where: { id, stock: { gte: 3 } },
      data: { stock: { decrement: 3 } },
    });
    expect(taken.count).toBe(0);
    await expect(db.physicalProduct.update({ where: { id }, data: { stock: { decrement: 3 } } })).rejects.toThrow(
      /PhysicalProduct_stock_nonnegative/,
    );
    expect((await db.physicalProduct.findUniqueOrThrow({ where: { id } })).stock).toBe(2);
  });

  it("allows at most 6 images, and never a missing list", async () => {
    const { seller } = await seedEvent();
    const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://img.example/${i}.jpg`);
    expect((await product(seller.id, { imageUrls: urls(6) })).imageUrls).toHaveLength(6);
    await expect(product(seller.id, { name: "Poster", imageUrls: urls(7) })).rejects.toThrow(
      /PhysicalProduct_images_limit/,
    );
    const { id } = await product(seller.id, { name: "Mug" });
    await expect(
      db.$executeRawUnsafe(`UPDATE "PhysicalProduct" SET "imageUrls" = NULL WHERE "id" = $1::uuid`, id),
    ).rejects.toThrow(/imageUrls/);
  });

  it("needs a publish date once published", async () => {
    const { seller } = await seedEvent();
    const { id } = await product(seller.id);
    await expect(db.physicalProduct.update({ where: { id }, data: { status: "PUBLISHED" } })).rejects.toThrow(
      /PhysicalProduct_published_has_date/,
    );
    const published = await db.physicalProduct.update({
      where: { id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    expect(published.status).toBe("PUBLISHED");
  });

  it("links only to the seller's own events, and unlinks when the event is deleted", async () => {
    const { seller, event } = await seedEvent();
    const { event: otherEvent } = await seedEvent();

    const shirt = await product(seller.id, { eventId: event.id });
    expect(shirt.eventId).toBe(event.id);
    await expect(product(seller.id, { name: "Poster", eventId: otherEvent.id })).rejects.toThrow(
      /PhysicalProduct_event_same_seller/,
    );
    await expect(
      db.physicalProduct.update({ where: { id: shirt.id }, data: { eventId: otherEvent.id } }),
    ).rejects.toThrow(/PhysicalProduct_event_same_seller/);

    await db.event.delete({ where: { id: event.id } });
    expect((await db.physicalProduct.findUniqueOrThrow({ where: { id: shirt.id } })).eventId).toBeNull();
  });

  it("keeps a seller who has products from being deleted", async () => {
    // No events, so only the product can block the delete.
    const seller = await db.user.create({ data: { displayName: "Merch only", role: "SELLER" } });
    await product(seller.id);
    await expect(db.user.delete({ where: { id: seller.id } })).rejects.toMatchObject({ code: "P2003" });
    expect(await db.physicalProduct.count()).toBe(1);
  });
});
