import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountNftsPage, NftOwnership } from "@/contracts/xrpl";
import { getDb } from "@/lib/db/client";

import { XrplServiceError } from "../errors";
import { nftokenIdFor } from "./__tests__/nft-ids";
import {
  getLedgerProof,
  getTicketView,
  listTicketsForOwner,
  resolveTicketOwnership,
  type OwnershipDeps,
} from "./ownership";

/** XRPL-028 ticket ownership against Postgres (`npm run test:db`), with the ledger faked. */

const db = getDb();
const SELLER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const BUYER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const STRANGER = "r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59";
const TX = (n: number) =>
  `E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B48${String(n).padStart(2, "0")}`;

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed() {
  const seller = await db.user.create({
    data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: seller.id,
      title: "Gig",
      startsAt: new Date("2027-03-12T20:00:00Z"),
      venue: "Rooms",
      city: "Dublin",
      status: "PUBLISHED",
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply: 10 },
  });
  const minted = (serial: number) =>
    db.ticketNFT.create({
      data: {
        eventId: event.id,
        tierId: tier.id,
        serial,
        issuerAddress: SELLER,
        mintStatus: "MINTED",
        nftokenId: nftokenIdFor(SELLER, 7, serial),
        mintTxHash: TX(serial),
        mintedAt: new Date(),
        metadataUri: `http://localhost:3000/api/tickets/t${serial}/metadata`,
        cachedOwnerAddress: SELLER,
        ownerSyncStatus: "SYNCED",
        ownerSyncLedgerIndex: 100,
      },
    });
  return { seller, event, tier, minted };
}

interface World {
  /** nftokenId -> holder on the validated ledger. */
  holders: Map<string, string>;
  ledgerIndex: number;
  /** What Clio's nft_info does: answer, fail, or report a burned NFT. */
  clio: "ok" | "unconfigured" | "down" | "unvalidated" | "burned";
  unfunded?: Set<string>;
}

function deps(world: World) {
  const provenance = (validated = true) => ({
    endpoint: "wss://node",
    ledgerIndex: world.ledgerIndex,
    ledgerHash: null,
    validated,
    fetchedAt: "",
  });
  const getOwner = vi.fn(async (nftokenId: string): Promise<NftOwnership> => {
    if (world.clio === "unconfigured")
      throw new XrplServiceError("CONFIG_ERROR", "Direct owner lookup needs a Clio node");
    if (world.clio === "down") throw new XrplServiceError("NODE_UNAVAILABLE", "No XRPL node reachable");
    const owner = world.holders.get(nftokenId);
    if (!owner) throw new XrplServiceError("NOT_FOUND", "objectNotFound");
    return {
      nftokenId,
      ownerAddress: owner,
      isBurned: world.clio === "burned",
      nft: null as never,
      provenance: provenance(world.clio !== "unvalidated"),
    };
  });
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.holders.get(nftokenId) === address,
    nft: null,
    provenance: provenance(),
  }));
  const getAccountNfts = vi.fn(async (address: string): Promise<AccountNftsPage> => {
    if (world.unfunded?.has(address)) throw new XrplServiceError("NOT_FOUND", "actNotFound");
    const items = [...world.holders.entries()]
      .filter(([, holder]) => holder === address)
      .map(([nftokenId]) => ({ nftokenId }) as AccountNftsPage["items"][number]);
    return { address, items, nextCursor: null, provenance: provenance() };
  });
  const ownershipDeps: OwnershipDeps = {
    db,
    ledger: () => ({ getOwner, verifyOwner, getAccountNfts }) as never,
    config: { explorerUrl: "https://testnet.xrpl.org" },
  };
  return { ownershipDeps, getOwner, verifyOwner };
}

describe("resolveTicketOwnership", () => {
  it("verifies the owner from a validated ledger and detects the change", async () => {
    const { minted } = await seed();
    const ticket = await minted(1);
    const { ownershipDeps } = deps({
      holders: new Map([[ticket.nftokenId!, BUYER]]),
      ledgerIndex: 500,
      clio: "ok",
    });

    const ownership = await resolveTicketOwnership(ownershipDeps, {
      ticketId: ticket.id,
      viewerAddress: BUYER,
    });
    expect(ownership).toMatchObject({
      status: "VERIFIED",
      ownerAddress: BUYER,
      ledgerIndex: 500,
      previousOwnerAddress: SELLER,
      changed: true,
      ownedByViewer: true,
      detail: null,
      nftExplorerUrl: `https://testnet.xrpl.org/nft/${ticket.nftokenId}`,
    });
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      cachedOwnerAddress: BUYER,
      ownerSyncStatus: "SYNCED",
      ownerSyncLedgerIndex: 500,
    });

    const again = await resolveTicketOwnership(ownershipDeps, { ticketId: ticket.id, viewerAddress: SELLER });
    expect(again).toMatchObject({ changed: false, ownedByViewer: false, previousOwnerAddress: BUYER });
  });

  it("never lets an answer from an older ledger overwrite a newer one", async () => {
    const { minted } = await seed();
    const ticket = await minted(1);
    await db.ticketNFT.update({ where: { id: ticket.id }, data: { ownerSyncLedgerIndex: 900 } });
    const { ownershipDeps } = deps({
      holders: new Map([[ticket.nftokenId!, BUYER]]),
      ledgerIndex: 500,
      clio: "ok",
    });

    await resolveTicketOwnership(ownershipDeps, { ticketId: ticket.id });
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      cachedOwnerAddress: SELLER,
      ownerSyncLedgerIndex: 900,
    });
  });

  it.each([
    ["the ledger can't be read", "down", "ERROR", /couldn't be read just now/],
    ["the answer isn't from a validated ledger", "unvalidated", "ERROR", /isn't validated yet/],
  ] as const)("shows ownership as pending, never owned, when %s", async (_case, clio, syncStatus, detail) => {
    const { minted } = await seed();
    const ticket = await minted(1);
    const { ownershipDeps } = deps({
      holders: new Map([[ticket.nftokenId!, SELLER]]),
      ledgerIndex: 500,
      clio,
    });

    const ownership = await resolveTicketOwnership(ownershipDeps, {
      ticketId: ticket.id,
      viewerAddress: SELLER,
    });
    expect(ownership).toMatchObject({ status: "PENDING", ownerAddress: null, ownedByViewer: false });
    expect(ownership.detail).toMatch(detail);
    // The display mirror keeps its last owner but is flagged, not refreshed.
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      cachedOwnerAddress: SELLER,
      ownerSyncStatus: syncStatus,
    });
  });

  it("without Clio, finds the owner among the wallets the app knows", async () => {
    const { minted } = await seed();
    const ticket = await minted(1);
    await db.nFTOffer.create({
      data: {
        ticketId: ticket.id,
        nftokenId: ticket.nftokenId!,
        kind: "PRIMARY",
        state: "ACCEPTED",
        ownerAddress: SELLER,
        amountDrops: "2500000",
        acceptedByAddress: BUYER,
      },
    });
    const { ownershipDeps, getOwner } = deps({
      holders: new Map([[ticket.nftokenId!, BUYER]]),
      ledgerIndex: 500,
      clio: "unconfigured",
    });

    expect(await resolveTicketOwnership(ownershipDeps, { ticketId: ticket.id })).toMatchObject({
      status: "VERIFIED",
      ownerAddress: BUYER,
      changed: true,
    });
    expect(getOwner).toHaveBeenCalled();
  });

  it("is pending when the NFT moved to a wallet the app hasn't seen", async () => {
    const { minted } = await seed();
    const ticket = await minted(1);
    const { ownershipDeps } = deps({
      holders: new Map([[ticket.nftokenId!, STRANGER]]),
      ledgerIndex: 500,
      clio: "unconfigured",
    });

    expect(await resolveTicketOwnership(ownershipDeps, { ticketId: ticket.id })).toMatchObject({
      status: "PENDING",
      ownerAddress: null,
      detail: "This ticket has moved to a wallet the app hasn't seen yet.",
    });
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).ownerSyncStatus).toBe(
      "STALE",
    );
  });

  it("reports unminted tickets and burned NFTs", async () => {
    const { event, tier, minted } = await seed();
    const unminted = await db.ticketNFT.create({
      data: { eventId: event.id, tierId: tier.id, serial: 99, mintStatus: "PENDING" },
    });
    const ticket = await minted(1);
    const { ownershipDeps } = deps({
      holders: new Map([[ticket.nftokenId!, BUYER]]),
      ledgerIndex: 500,
      clio: "burned",
    });

    expect(await resolveTicketOwnership(ownershipDeps, { ticketId: unminted.id })).toMatchObject({
      status: "NOT_MINTED",
      ownerAddress: null,
      nftokenId: null,
    });
    expect(await resolveTicketOwnership(ownershipDeps, { ticketId: ticket.id })).toMatchObject({
      status: "BURNED",
      ownerAddress: null,
    });
    expect(
      (await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).cachedOwnerAddress,
    ).toBeNull();
    await expect(
      resolveTicketOwnership(ownershipDeps, { ticketId: "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("listTicketsForOwner", () => {
  it("lists the tickets a wallet holds on a validated ledger, and notices tickets it no longer holds", async () => {
    const { seller, event, minted } = await seed();
    const [kept, bought, gone] = await Promise.all([minted(1), minted(2), minted(3)]);
    await db.ticketNFT.update({ where: { id: gone.id }, data: { cachedOwnerAddress: BUYER } });
    await db.ledgerTransaction.create({
      data: {
        type: "NFTokenAcceptOffer",
        hash: TX(42),
        account: BUYER,
        status: "VALIDATED_SUCCESS",
        validatedAt: new Date(),
        relatedTicketId: bought.id,
      },
    });
    const { ownershipDeps } = deps({
      holders: new Map([
        [kept.nftokenId!, BUYER],
        [bought.nftokenId!, BUYER],
        [gone.nftokenId!, STRANGER], // sold on outside the app
        [nftokenIdFor(STRANGER, 1, 1), BUYER], // an NFT that is not a ticket
      ]),
      ledgerIndex: 700,
      clio: "ok",
    });

    const tickets = await listTicketsForOwner(ownershipDeps, { address: BUYER, viewerAddress: BUYER });
    expect(tickets.map((t) => t.serial)).toEqual([1, 2]);
    expect(tickets[1]).toMatchObject({
      id: bought.id,
      eventId: event.id,
      tierName: "GA",
      priceDrops: "2500000",
      event: { title: "Gig", venue: "Rooms", city: "Dublin", sellerDisplayName: seller.displayName },
      ledger: {
        nftokenId: bought.nftokenId,
        issuerAddress: SELLER,
        ownerAddress: BUYER,
        mintTxHash: TX(2),
        lastTransferTxHash: TX(42),
        ledgerIndex: 700,
        explorerTxUrl: `https://testnet.xrpl.org/transactions/${TX(42)}`,
        explorerNftUrl: `https://testnet.xrpl.org/nft/${bought.nftokenId}`,
      },
      checkedInAt: null,
      ownedByViewer: true,
    });
    expect(tickets[0]!.ledger.lastTransferTxHash).toBeNull();

    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({
      cachedOwnerAddress: BUYER,
      ownerSyncStatus: "SYNCED",
      ownerSyncLedgerIndex: 700,
    });
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: gone.id } })).ownerSyncStatus).toBe("STALE");
  });

  it("returns nothing for a wallet with no account on the network", async () => {
    await seed();
    const { ownershipDeps } = deps({
      holders: new Map(),
      ledgerIndex: 700,
      clio: "ok",
      unfunded: new Set([BUYER]),
    });
    expect(await listTicketsForOwner(ownershipDeps, { address: BUYER })).toEqual([]);
  });
});

describe("getTicketView and getLedgerProof", () => {
  it("gives the full view and ledger proof only when ownership is verified", async () => {
    const { minted } = await seed();
    const ticket = await minted(1);
    const world: World = { holders: new Map([[ticket.nftokenId!, BUYER]]), ledgerIndex: 800, clio: "ok" };
    const { ownershipDeps } = deps(world);

    const verified = await getTicketView(ownershipDeps, { ticketId: ticket.id, viewerAddress: BUYER });
    expect(verified.ownership.status).toBe("VERIFIED");
    expect(verified.ticket).toMatchObject({
      id: ticket.id,
      ownedByViewer: true,
      ledger: { ownerAddress: BUYER },
    });
    expect(await getLedgerProof(ownershipDeps, ticket.nftokenId!)).toMatchObject({
      ownerAddress: BUYER,
      mintTxHash: TX(1),
      ledgerIndex: 800,
    });

    world.clio = "down";
    const pending = await getTicketView(ownershipDeps, { ticketId: ticket.id, viewerAddress: BUYER });
    expect(pending).toMatchObject({ ticket: null, ownership: { status: "PENDING", ownedByViewer: false } });
    expect(await getLedgerProof(ownershipDeps, ticket.nftokenId!)).toBeNull();
  });
});
