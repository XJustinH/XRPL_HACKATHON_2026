import { convertHexToString } from "xrpl";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmedLedgerTx, TransactionRequest, TransactionRequestStatus } from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { getEventMints, reconcileTicketMint, requestTicketMint, type MintDeps } from "./minting";
import { nftokenIdFor } from "./__tests__/nft-ids";
import { ticketTaxon } from "./metadata";

/** XRPL-024 minting against Postgres (`npm run test:db`), with Xaman and the ledger faked. */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const REQUEST_ID = "515b9d76-f7cc-4f3b-979e-a82500340424";
const TX_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(totalSupply = 2) {
  const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER" } });
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
  return { seller, event, tier };
}

/** A signed-in session; by default with ISSUER proven as its wallet (XRPL-012). */
function session(
  userId: string,
  role: AuthSession["role"] = "SELLER",
  walletAddress: string | null = ISSUER,
): AuthSession {
  return {
    sessionId: "s",
    userId,
    displayName: "x",
    role,
    onboardedAt: new Date(),
    isDemo: true,
    method: "DEMO_PERSONA",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress,
    walletVerifiedAt: walletAddress ? new Date() : null,
  };
}

function txRequest(
  status: TransactionRequestStatus,
  extra: Partial<TransactionRequest> = {},
): TransactionRequest {
  return {
    id: REQUEST_ID,
    purpose: "MINT_TICKET",
    reference: null,
    status,
    transactionType: "NFTokenMint",
    account: ISSUER,
    instruction: "Mint",
    signUrl: `https://xumm.app/sign/${REQUEST_ID}`,
    qrPngUrl: `https://xumm.app/sign/${REQUEST_ID}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...extra,
  };
}

function deps(state: { request: TransactionRequest; nftokenId?: string; uri?: string | null }) {
  const create = vi.fn(async () => state.request);
  const get = vi.fn(async () => state.request);
  const getValidatedTx = vi.fn(async (): Promise<ConfirmedLedgerTx> => ({
    hash: TX_HASH,
    validated: true,
    result: "tesSUCCESS",
    ledgerIndex: 1234,
    closeTime: "2026-11-20T19:00:00.000Z",
    transactionType: "NFTokenMint",
    account: ISSUER,
    nftokenId: state.nftokenId ?? null,
    offerIndex: null,
    explorerUrl: `https://testnet.xrpl.org/transactions/${TX_HASH}`,
  }));
  const verifyOwner = vi.fn(async () => ({
    nftokenId: state.nftokenId ?? "",
    address: ISSUER,
    owns: true,
    nft: state.uri === undefined ? null : ({ uri: state.uri } as never),
    provenance: {
      endpoint: "wss://node",
      ledgerIndex: 1235,
      ledgerHash: null,
      validated: true,
      fetchedAt: "",
    },
  }));
  const mintDeps: MintDeps = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org" },
    baseUrl: "http://localhost:3000",
  };
  return { mintDeps, create, get, getValidatedTx };
}

describe("requestTicketMint", () => {
  it("reserves a ticket and asks the seller's wallet to sign a matching NFTokenMint", async () => {
    const { seller, event, tier } = await seed();
    const { mintDeps, create } = deps({ request: txRequest("PENDING") });

    const result = await requestTicketMint(mintDeps, {
      session: session(seller.id),
      eventId: event.id,
      tierId: tier.id,
    });

    expect(result.ticket).toMatchObject({ serial: 1, mintStatus: "PENDING", nftokenId: null });
    expect(result.metadataPublic).toBe(false); // localhost
    const [input] = create.mock.calls[0] as unknown as [
      { purpose: string; reference: string; txjson: Record<string, unknown> },
    ];
    expect(input.purpose).toBe("MINT_TICKET");
    expect(input.reference).toBe(result.ticket.id);
    expect(input.txjson).toMatchObject({
      TransactionType: "NFTokenMint",
      Account: ISSUER,
      NFTokenTaxon: ticketTaxon(event.id),
      Flags: 8,
    });
    expect(convertHexToString(String(input.txjson.URI))).toBe(result.ticket.metadataUri);

    const ledgerTx = await db.ledgerTransaction.findFirstOrThrow({
      where: { relatedTicketId: result.ticket.id },
    });
    expect(ledgerTx).toMatchObject({
      type: "NFTokenMint",
      status: "PENDING",
      signRequestRef: REQUEST_ID,
      appliedAt: null,
    });
  });

  it("only lets the event's owner mint, with a proven wallet", async () => {
    const { seller, event, tier } = await seed();
    const other = await db.user.create({ data: { displayName: "Other", role: "SELLER" } });
    const customer = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER" } });
    const { mintDeps, create } = deps({ request: txRequest("PENDING") });
    const attempt = (who: AuthSession, eventId = event.id) =>
      requestTicketMint(mintDeps, { session: who, eventId, tierId: tier.id });

    await expect(attempt(session(other.id))).rejects.toMatchObject({ status: 403, code: "NOT_EVENT_OWNER" });
    await expect(attempt(session(customer.id, "CUSTOMER"))).rejects.toMatchObject({ status: 403 });
    await expect(attempt(session(seller.id), "6f1d3c2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f")).rejects.toMatchObject({
      status: 404,
    });
    await expect(attempt(session(seller.id, "SELLER", null))).rejects.toMatchObject({
      status: 403,
      code: "WALLET_NOT_VERIFIED",
    });
    expect(create).not.toHaveBeenCalled();
    expect(await db.ticketNFT.count()).toBe(0);
  });

  it("releases the reservation when the wallet service is down", async () => {
    const { seller, event, tier } = await seed(1);
    const { mintDeps, create } = deps({ request: txRequest("PENDING") });
    create.mockRejectedValueOnce(new Error("Xaman down"));
    const input = { session: session(seller.id), eventId: event.id, tierId: tier.id };

    await expect(requestTicketMint(mintDeps, input)).rejects.toThrow("Xaman down");
    expect((await db.ticketNFT.findFirstOrThrow()).mintStatus).toBe("FAILED");
    // The single-ticket tier is still mintable: the failed reservation is reused.
    expect((await requestTicketMint(mintDeps, input)).ticket.serial).toBe(1);
  });
});

describe("reconcileTicketMint", () => {
  async function mintRequested(state: Parameters<typeof deps>[0]) {
    const { seller, event, tier } = await seed();
    const d = deps(state);
    const { ticket } = await requestTicketMint(d.mintDeps, {
      session: session(seller.id),
      eventId: event.id,
      tierId: tier.id,
    });
    return { ...d, ticket, event, tier, seller };
  }

  it("marks the ticket MINTED from the validated mint, exactly once", async () => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { mintDeps, ticket, event, tier } = await mintRequested(state);
    state.nftokenId = nftokenIdFor(ISSUER, ticketTaxon(event.id));
    state.uri = ticket.metadataUri;
    state.request = txRequest("CONFIRMED", {
      txHash: TX_HASH,
      engineResult: "tesSUCCESS",
      ledgerIndex: 1234,
    });

    const minted = await reconcileTicketMint(mintDeps, ticket.id);
    expect(minted).toMatchObject({
      mintStatus: "MINTED",
      nftokenId: state.nftokenId,
      mintTxHash: TX_HASH,
      issuerAddress: ISSUER,
      cachedOwnerAddress: ISSUER,
      ownerSyncStatus: "SYNCED",
    });
    await reconcileTicketMint(mintDeps, ticket.id); // replay: no second effect
    expect((await db.ticketTier.findUniqueOrThrow({ where: { id: tier.id } })).mintedQuantity).toBe(1);
    expect(
      await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } }),
    ).toMatchObject({
      hash: TX_HASH,
      status: "VALIDATED_SUCCESS",
      resultCode: "tesSUCCESS",
    });
  });

  it("never downgrades a ticket that a concurrent reconcile already minted", async () => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { mintDeps, ticket, event, get } = await mintRequested(state);
    state.nftokenId = nftokenIdFor(ISSUER, ticketTaxon(event.id));
    state.uri = ticket.metadataUri;
    // While this reconcile waits on Xaman (which still says SUBMITTED), a faster one confirms the mint.
    get.mockImplementationOnce(async () => {
      state.request = txRequest("CONFIRMED", { txHash: TX_HASH });
      await reconcileTicketMint(mintDeps, ticket.id);
      return txRequest("SUBMITTED", { txHash: TX_HASH });
    });

    expect((await reconcileTicketMint(mintDeps, ticket.id)).mintStatus).toBe("MINTED");
    expect((await db.ledgerTransaction.findFirstOrThrow()).status).toBe("VALIDATED_SUCCESS");
  });

  it("refuses to record an NFT that does not match the ticket", async () => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { mintDeps, ticket } = await mintRequested(state);
    state.nftokenId = nftokenIdFor(ISSUER, 12345); // wrong taxon for this event
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH });

    await expect(reconcileTicketMint(mintDeps, ticket.id)).rejects.toThrow(/does not match/);
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticket.id } })).mintStatus).toBe("PENDING");
  });

  it.each([
    ["REJECTED", {}, "DROPPED"],
    ["EXPIRED", {}, "DROPPED"],
    [
      "FAILED",
      { failureReason: "LEDGER_REJECTED", engineResult: "tecNO_PERMISSION", txHash: TX_HASH },
      "VALIDATED_FAILURE",
    ],
  ] as const)("marks a %s mint FAILED without inventing an NFT", async (status, extra, ledgerStatus) => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { mintDeps, ticket, tier } = await mintRequested(state);
    state.request = txRequest(status, extra);

    expect(await reconcileTicketMint(mintDeps, ticket.id)).toMatchObject({
      mintStatus: "FAILED",
      nftokenId: null,
    });
    expect((await db.ticketTier.findUniqueOrThrow({ where: { id: tier.id } })).mintedQuantity).toBe(0);
    expect(
      (await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } })).status,
    ).toBe(ledgerStatus);
  });

  it("tracks a signed mint as SUBMITTED until it validates", async () => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { mintDeps, ticket } = await mintRequested(state);
    state.request = txRequest("SUBMITTED", { txHash: TX_HASH });

    expect((await reconcileTicketMint(mintDeps, ticket.id)).mintStatus).toBe("SUBMITTED");
    expect((await db.ledgerTransaction.findFirstOrThrow()).hash).toBe(TX_HASH);
  });
});

describe("getEventMints", () => {
  it("lists tiers with their tickets after reconciling mints in flight", async () => {
    const state: Parameters<typeof deps>[0] = { request: txRequest("PENDING") };
    const { seller, event, tier } = await seed();
    const d = deps(state);
    const { ticket } = await requestTicketMint(d.mintDeps, {
      session: session(seller.id),
      eventId: event.id,
      tierId: tier.id,
    });
    state.nftokenId = nftokenIdFor(ISSUER, ticketTaxon(event.id));
    state.uri = ticket.metadataUri;
    state.request = txRequest("CONFIRMED", { txHash: TX_HASH });

    const mints = await getEventMints(d.mintDeps, { session: session(seller.id), eventId: event.id });
    expect(mints.tiers).toHaveLength(1);
    expect(mints.tiers[0]).toMatchObject({ id: tier.id, mintedQuantity: 1 });
    expect(mints.tiers[0]!.tickets[0]).toMatchObject({
      id: ticket.id,
      mintStatus: "MINTED",
      nftExplorerUrl: `https://testnet.xrpl.org/nft/${state.nftokenId}`,
      mintTxExplorerUrl: `https://testnet.xrpl.org/transactions/${TX_HASH}`,
    });
  });
});
