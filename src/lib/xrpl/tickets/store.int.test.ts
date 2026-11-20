import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call next/server's connection(), which only works inside a real request.
vi.mock("next/server", () => ({ connection: async () => {} }));

import { GET as imageGET } from "@/app/api/tickets/[id]/image/route";
import { GET as metadataGET } from "@/app/api/tickets/[id]/metadata/route";
import { TicketNftMetadata } from "@/contracts/xrpl";
import { getDb } from "@/lib/db/client";

import { createPendingTicket, findTicketForMetadata } from "./store";

/** XRPL-023 ticket records and public metadata against Postgres (`npm run test:db`). */

const db = getDb();
const BASE = "http://localhost:3000";
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seedEvent(totalSupply = 2) {
  const seller = await db.user.create({ data: { displayName: "Venue", role: "SELLER" } });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig <Live>",
      description: "Original songs.",
      startsAt: new Date("2027-03-12T20:00:00Z"),
      venue: "The Ledger Rooms",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply },
  });
  return { seller, event, tier };
}

const reserve = (eventId: string, tierId: string) =>
  createPendingTicket(db, { eventId, tierId, issuerAddress: ISSUER, baseUrl: BASE });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("createPendingTicket", () => {
  it("allocates serials in order and stores each ticket's own metadata URI", async () => {
    const { event, tier } = await seedEvent();
    const first = await reserve(event.id, tier.id);
    const second = await reserve(event.id, tier.id);

    expect([first.serial, second.serial]).toEqual([1, 2]);
    expect(first).toMatchObject({ mintStatus: "PENDING", issuerAddress: ISSUER, nftokenId: null });
    expect(first.metadataUri).toBe(`${BASE}/api/tickets/${first.id}/metadata`);
    expect(second.metadataUri).not.toBe(first.metadataUri);
  });

  it("refuses to allocate beyond the tier's supply", async () => {
    const { event, tier } = await seedEvent(1);
    await reserve(event.id, tier.id);
    await expect(reserve(event.id, tier.id)).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("reuses a ticket whose mint failed before allocating a new serial", async () => {
    const { event, tier } = await seedEvent(1);
    const failed = await reserve(event.id, tier.id);
    await db.ticketNFT.update({ where: { id: failed.id }, data: { mintStatus: "FAILED" } });

    const retried = await reserve(event.id, tier.id);
    expect(retried).toMatchObject({ id: failed.id, serial: 1, mintStatus: "PENDING" });
  });

  it("never reserves beyond supply under concurrent requests (XRPL-025)", async () => {
    const { event, tier } = await seedEvent(3);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(event.id, tier.id)));

    const reserved = results.filter((r) => r.status === "fulfilled");
    expect(reserved).toHaveLength(3);
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    const serials = (await db.ticketNFT.findMany({ where: { tierId: tier.id }, select: { serial: true } }))
      .map((t) => t.serial)
      .sort();
    expect(serials).toEqual([1, 2, 3]);
  });

  it("gives each failed ticket to only one of many concurrent requests", async () => {
    const { event, tier } = await seedEvent(3);
    const kept = await reserve(event.id, tier.id);
    const failedA = await reserve(event.id, tier.id);
    const failedB = await reserve(event.id, tier.id);
    await db.ticketNFT.updateMany({
      where: { id: { in: [failedA.id, failedB.id] } },
      data: { mintStatus: "FAILED" },
    });

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(event.id, tier.id)));
    const taken = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : []));
    expect(taken.sort()).toEqual([failedA.id, failedB.id].sort()); // each reused exactly once
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    expect(await db.ticketNFT.count({ where: { tierId: tier.id } })).toBe(3);
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: kept.id } })).mintStatus).toBe("PENDING");
  });

  it("rejects a tier that belongs to another event", async () => {
    const one = await seedEvent();
    const other = await seedEvent();
    await expect(reserve(one.event.id, other.tier.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("public ticket metadata and image", () => {
  it("serves contract-valid metadata at the URI stored on the ticket", async () => {
    const { event, tier } = await seedEvent();
    const ticket = await reserve(event.id, tier.id);

    const res = await metadataGET(new Request(ticket.metadataUri!), ctx(ticket.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const metadata = TicketNftMetadata.parse(await res.json());
    expect(metadata.ticket).toMatchObject({
      ticketId: ticket.id,
      eventId: event.id,
      tierId: tier.id,
      serial: 1,
    });
    expect(metadata.image).toBe(`${BASE}/api/tickets/${ticket.id}/image`);
    expect(await findTicketForMetadata(db, ticket.id)).toMatchObject({ id: ticket.id, tier: { name: "GA" } });
  });

  it("serves the generated image as a script-free SVG", async () => {
    const { event, tier } = await seedEvent();
    const ticket = await reserve(event.id, tier.id);

    const res = await imageGET(new Request(`${BASE}/api/tickets/${ticket.id}/image`), ctx(ticket.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const svg = await res.text();
    expect(svg).toContain("Gig &lt;Live&gt;");
  });

  it("answers 404 for unknown or malformed ticket IDs", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await metadataGET(new Request(`${BASE}/x`), ctx(unknown))).status).toBe(404);
    expect((await metadataGET(new Request(`${BASE}/x`), ctx("not-a-uuid"))).status).toBe(404);
    expect((await imageGET(new Request(`${BASE}/x`), ctx(unknown))).status).toBe(404);
  });
});
