import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountMintsPage, ConfirmedLedgerTx, LedgerMint } from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { XrplServiceError } from "../errors";
import { nftokenIdFor } from "./__tests__/nft-ids";
import { reconcileEventMappings, type MappingDeps } from "./mapping";
import { ticketTaxon, TICKET_MEMO_TYPE } from "./metadata";
import { createPendingTicket } from "./store";

/** XRPL-026 mapping reconciliation against Postgres (`npm run test:db`), with the ledger faked. */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const TX_1 = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const TX_2 = "FDA1B6E60466B33558E246E9C4EB697B39D62FB39C908E8CD2B0A13168847014";
const BASE_URL = "http://localhost:3000";

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "WalletProof","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(totalSupply = 5) {
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
    data: { eventId: event.id, name: "GA", priceDrops: "2500000", totalSupply },
  });
  const reserve = () =>
    createPendingTicket(db, { eventId: event.id, tierId: tier.id, issuerAddress: ISSUER, baseUrl: BASE_URL });
  return { seller, event, tier, reserve };
}

function session(userId: string): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role: "SELLER",
    onboardedAt: new Date(),
    isDemo: true,
    method: "DEMO_PERSONA",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: ISSUER,
    walletVerifiedAt: new Date(),
  };
}

/** A validated ticket mint as it appears in the issuer's history. */
function mintFor(
  ticket: { id: string; metadataUri: string | null; eventId: string },
  extra: Partial<LedgerMint> = {},
): LedgerMint {
  const taxon = ticketTaxon(ticket.eventId);
  return {
    hash: TX_1,
    ledgerIndex: 1234,
    closeTime: "2026-11-20T19:00:00Z",
    account: ISSUER,
    issuer: ISSUER,
    engineResult: "tesSUCCESS",
    succeeded: true,
    nftokenId: nftokenIdFor(ISSUER, taxon),
    taxon,
    uri: ticket.metadataUri,
    memos: [{ type: TICKET_MEMO_TYPE, data: ticket.id }],
    explorerUrl: `https://testnet.xrpl.org/transactions/${TX_1}`,
    ...extra,
  };
}

function fakeLedger(
  history: LedgerMint[],
  validated: (hash: string) => ConfirmedLedgerTx | Error = notFound,
) {
  const getAccountMints = vi.fn(async (address: string): Promise<AccountMintsPage> => ({
    address,
    items: history.filter((mint) => mint.issuer === address),
    scanned: history.length,
    nextCursor: null,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 2000,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const getValidatedTx = vi.fn(async (hash: string) => {
    const answer = validated(hash);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const verifyOwner = vi.fn(async () => ({
    owns: true,
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 2001,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const deps: MappingDeps = {
    db,
    ledger: () => ({ getAccountMints, getValidatedTx, verifyOwner }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org" },
  };
  return { deps, getAccountMints, getValidatedTx };
}

function notFound(hash: string): Error {
  return new XrplServiceError("NOT_VALIDATED", `Transaction ${hash} is not in a validated ledger (yet)`);
}

function confirmedMint(hash: string, nftokenId: string, account = ISSUER): ConfirmedLedgerTx {
  return {
    hash,
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 1234,
    closeTime: "2026-11-20T19:00:00Z",
    transactionType: "NFTokenMint",
    account,
    nftokenId,
    offerIndex: null,
    explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
  };
}

describe("reconcileEventMappings: rebuilding from the ledger", () => {
  it("records a validated mint the app missed, exactly once", async () => {
    const { seller, event, tier, reserve } = await seed();
    const ticket = await reserve();
    // The mint request the app made: its outcome was lost (e.g. the wallet service forgot it).
    const pending = await db.ledgerTransaction.create({
      data: {
        type: "NFTokenMint",
        network: "TESTNET",
        account: ISSUER,
        status: "PENDING",
        signRequestRef: "515b9d76-f7cc-4f3b-979e-a82500340424",
        relatedTicketId: ticket.id,
      },
    });
    const mint = mintFor(ticket);
    const { deps } = fakeLedger([mint]);

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report).toMatchObject({
      issuers: [ISSUER],
      mintsFound: 1,
      recorded: [ticket.id],
      verified: 1,
      issues: [],
      complete: true,
    });
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).toMatchObject({
      mintStatus: "MINTED",
      nftokenId: mint.nftokenId,
      mintTxHash: TX_1,
      mintedAt: new Date("2026-11-20T19:00:00Z"),
      issuerAddress: ISSUER,
      cachedOwnerAddress: ISSUER,
    });
    // The request's own ledger record is the one completed; no second row.
    expect(await db.ledgerTransaction.findMany()).toEqual([
      expect.objectContaining({
        id: pending.id,
        hash: TX_1,
        status: "VALIDATED_SUCCESS",
        appliedAt: expect.any(Date),
      }),
    ]);

    const again = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(again).toMatchObject({ recorded: [], verified: 1, issues: [] });
    expect((await db.ticketTier.findUniqueOrThrow({ where: { id: tier.id } })).mintedQuantity).toBe(1);
  });

  it("rebuilds a ticket whose mint was wrongly marked failed", async () => {
    const { seller, event, reserve } = await seed();
    const ticket = await reserve();
    await db.ticketNFT.update({ where: { id: ticket.id }, data: { mintStatus: "FAILED" } });
    const { deps } = fakeLedger([mintFor(ticket)]);

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.recorded).toEqual([ticket.id]);
    expect((await db.ledgerTransaction.findFirstOrThrow()).hash).toBe(TX_1); // a new record, by hash
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).mintStatus).toBe("MINTED");
  });

  it("ignores failed mints, mints without a ticket memo and other events' tickets", async () => {
    const { seller, event, reserve } = await seed();
    const ticket = await reserve();
    const other = await seed();
    const otherTicket = await other.reserve();
    const { deps } = fakeLedger([
      mintFor(ticket, { succeeded: false, engineResult: "tecINSUFFICIENT_RESERVE", nftokenId: null }),
      mintFor(ticket, { hash: TX_2, memos: [] }),
      mintFor(otherTicket, { hash: TX_2 }),
    ]);

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report).toMatchObject({ mintsFound: 0, recorded: [], verified: 0, issues: [] });
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).mintStatus).toBe("PENDING");
  });
});

describe("reconcileEventMappings: disagreements are reported, never overwritten", () => {
  it("rejects one NFT for two tickets at the database layer", async () => {
    const { seller, event, reserve } = await seed();
    const first = await reserve();
    const second = await reserve();
    const nftokenId = nftokenIdFor(ISSUER, ticketTaxon(event.id));
    await db.ticketNFT.update({ where: { id: first.id }, data: { nftokenId } });

    await expect(
      db.ticketNFT.update({ where: { id: second.id }, data: { nftokenId } }),
    ).rejects.toMatchObject({
      code: "P2002",
    });

    // The ledger (wrongly) shows a mint naming the second ticket with the same NFT.
    const { deps } = fakeLedger([mintFor(second, { nftokenId })]);
    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.issues).toEqual([
      expect.objectContaining({ problem: "NFT_MAPPED_TO_OTHER_TICKET", ticketId: second.id, nftokenId }),
    ]);
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      mintStatus: "PENDING",
      nftokenId: null,
    });
    expect(await db.ledgerTransaction.count()).toBe(0); // rolled back
  });

  it("reports a ticket the ledger shows with a second NFT", async () => {
    const { seller, event, reserve } = await seed();
    const ticket = await reserve();
    const recordedNft = nftokenIdFor(ISSUER, ticketTaxon(event.id), 7);
    await db.ticketNFT.update({
      where: { id: ticket.id },
      data: { mintStatus: "MINTED", nftokenId: recordedNft, mintTxHash: TX_1, mintedAt: new Date() },
    });
    const { deps } = fakeLedger(
      [
        mintFor(ticket),
        mintFor(ticket, { hash: TX_2, nftokenId: nftokenIdFor(ISSUER, ticketTaxon(event.id), 8) }),
      ],
      (hash) => confirmedMint(hash, recordedNft),
    );

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.verified).toBe(1);
    expect(report.issues).toEqual([
      expect.objectContaining({ problem: "TICKET_HAS_OTHER_NFT", ticketId: ticket.id, txHash: TX_2 }),
    ]);
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).nftokenId).toBe(recordedNft);
  });

  it("reports mints with the wrong URI or taxon, and mints for tickets it has no record of", async () => {
    const { seller, event, reserve } = await seed();
    const ticket = await reserve();
    const otherTicket = await reserve();
    const { deps } = fakeLedger([
      mintFor(ticket, { uri: "https://elsewhere.example/metadata.json" }),
      mintFor(otherTicket, { hash: TX_2, taxon: 42 }),
      mintFor(
        { id: "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f", metadataUri: null, eventId: event.id },
        { hash: "B".repeat(64) },
      ),
    ]);

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.issues.map((issue) => issue.problem).sort()).toEqual([
      "TAXON_MISMATCH",
      "TICKET_NOT_FOUND",
      "URI_MISMATCH",
    ]);
    expect(report.recorded).toEqual([]);
  });
});

describe("reconcileEventMappings: verifying minted tickets", () => {
  async function mintedTicket(nftokenId?: string) {
    const seeded = await seed();
    const ticket = await seeded.reserve();
    const id = nftokenId ?? nftokenIdFor(ISSUER, ticketTaxon(seeded.event.id));
    await db.ticketNFT.update({
      where: { id: ticket.id },
      data: { mintStatus: "MINTED", nftokenId: id, mintTxHash: TX_1, mintedAt: new Date() },
    });
    return { ...seeded, ticket, nftokenId: id };
  }

  it("confirms a minted ticket against its validated mint transaction", async () => {
    const { seller, event, nftokenId } = await mintedTicket();
    const { deps, getValidatedTx } = fakeLedger([], (hash) => confirmedMint(hash, nftokenId));

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report).toMatchObject({ verified: 1, issues: [] });
    expect(getValidatedTx).toHaveBeenCalledWith(TX_1);
  });

  it("flags a recorded mint transaction that shows a different NFT", async () => {
    const { seller, event, ticket } = await mintedTicket();
    const { deps } = fakeLedger([], (hash) => confirmedMint(hash, nftokenIdFor(ISSUER, 99)));

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.verified).toBe(0);
    expect(report.issues).toEqual([
      expect.objectContaining({ problem: "MINT_TX_MISMATCH", ticketId: ticket.id }),
    ]);
  });

  it("flags a recorded mint transaction the ledger cannot confirm", async () => {
    const { seller, event } = await mintedTicket();
    const { deps } = fakeLedger([]);

    const report = await reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id });
    expect(report.issues).toEqual([expect.objectContaining({ problem: "MINT_TX_NOT_VALIDATED" })]);
  });

  it("passes ledger outages through instead of reporting false problems", async () => {
    const { seller, event } = await mintedTicket();
    const { deps } = fakeLedger([], () => new XrplServiceError("NODE_UNAVAILABLE", "No XRPL node reachable"));

    await expect(
      reconcileEventMappings(deps, { session: session(seller.id), eventId: event.id }),
    ).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
  });
});

describe("reconcileEventMappings: access and limits", () => {
  it("only lets the event's owner run it", async () => {
    const { event } = await seed();
    const other = await db.user.create({
      data: { displayName: "Other", role: "SELLER", onboardedAt: new Date() },
    });
    const { deps, getAccountMints } = fakeLedger([]);

    await expect(
      reconcileEventMappings(deps, { session: session(other.id), eventId: event.id }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      reconcileEventMappings(deps, {
        session: session(other.id),
        eventId: "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(getAccountMints).not.toHaveBeenCalled();
  });

  it("says when an issuer's history was too long to read in one run", async () => {
    const { seller, event, reserve } = await seed();
    await reserve();
    const { deps, getAccountMints } = fakeLedger([]);
    getAccountMints.mockImplementation(async (address: string) => ({
      address,
      items: [],
      scanned: 400,
      nextCursor: "MORE",
      provenance: {
        endpoint: "wss://node",
        ledgerIndex: 2000,
        ledgerHash: null,
        validated: true,
        fetchedAt: "",
      },
    }));

    const report = await reconcileEventMappings(deps, {
      session: session(seller.id),
      eventId: event.id,
      maxPages: 2,
    });
    expect(report.complete).toBe(false);
    expect(getAccountMints).toHaveBeenCalledTimes(2);
  });
});
