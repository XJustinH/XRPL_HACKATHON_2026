import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConfirmedLedgerTx,
  LedgerMint,
  LedgerTxLookup,
  MintTicketView,
  TransactionRequest,
  TransactionRequestStatus,
} from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";

import { loadXrplConfig } from "../config";
import { XrplServiceError } from "../errors";
import { UNSIGNABLE_AFTER_MS } from "../offers/primary";
import { WalletTransactionRequests } from "../wallet/transaction-requests";
import type { CreatePayloadInput, XamanClient, XamanPayloadResult } from "../wallet/xaman";
import {
  getEventMints,
  MINT_LEDGER_WINDOW,
  reconcileTicketMint,
  requestTicketMint,
  type MintDeps,
} from "./minting";
import { nftokenIdFor } from "./__tests__/nft-ids";
import { ticketTaxon, TICKET_MEMO_TYPE } from "./metadata";
import { createPendingTicket, reserveTicketMint } from "./store";

/**
 * XRPL-027 against Postgres (`npm run test:db`): a failed mint says why, a retry never mints a ticket
 * twice, and a tier's inventory stays consistent after a partial failure. Xaman and the ledger are
 * controllable fakes.
 */

const db = getDb();
const ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const XRP = 1_000_000;
const EXPLORER = "https://testnet.xrpl.org";
const provenance = {
  endpoint: "wss://node",
  ledgerIndex: 6000,
  ledgerHash: null,
  validated: true,
  fetchedAt: "",
};
/** Long enough ago that nothing more can be signed for a request made then. */
const longAgo = () => new Date(Date.now() - UNSIGNABLE_AFTER_MS - 60_000);

type Ticket = Pick<MintTicketView, "id" | "eventId" | "metadataUri">;

/** One page of the issuer's history, as the node returns it. */
interface HistoryPage {
  items: LedgerMint[];
  /** When the oldest transaction on the page closed, mint or not; null for an empty page. */
  oldest: Date | null;
}

const world = {
  account: { exists: true, balanceDrops: String(100 * XRP), ownerCount: 0 },
  requests: new Map<string, TransactionRequest>(),
  /** Request IDs Xaman no longer has. */
  forgotten: new Set<string>(),
  xamanDown: false,
  /** Transactions on the ledger, by hash. */
  txs: new Map<string, LedgerTxLookup>(),
  /** NFTs the issuer holds: NFTokenID -> URI. */
  nfts: new Map<string, string>(),
  /** The issuer's validated mints, newest first: its whole history, on one page. */
  history: [] as LedgerMint[],
  /** The issuer's history page by page, when a test needs more than `history`. */
  pages: null as HistoryPage[] | null,
  /** A busy issuer: every page says there is more, and further pages hold recent non-mints. */
  endlessHistory: false,
  /** The first ledger the node keeps history from. */
  earliestLedger: 1 as number | null,
  sequence: 0,
  /** The latest validated ledger; null when the node has none. */
  validatedIndex: 6000 as number | null,
};

function txRequest(
  id: string,
  status: TransactionRequestStatus,
  reference: string | null,
): TransactionRequest {
  return {
    id,
    purpose: "MINT_TICKET",
    reference,
    status,
    transactionType: "NFTokenMint",
    account: ISSUER,
    instruction: "Mint",
    signUrl: `https://xumm.app/sign/${id}`,
    qrPngUrl: `https://xumm.app/sign/${id}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
  };
}

const create = vi.fn(async (input: { reference?: string | null; txjson?: Record<string, unknown> }) => {
  const request = txRequest(randomUUID(), "PENDING", input.reference ?? null);
  world.requests.set(request.id, request);
  return request;
});
const get = vi.fn(async (id: string) => {
  if (world.xamanDown) throw new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unreachable");
  const request = world.requests.get(id);
  if (!request || world.forgotten.has(id))
    throw new XrplServiceError("NOT_FOUND", "Transaction request not found");
  return request;
});

const notFound = (hash: string): LedgerTxLookup => ({
  hash,
  status: "NOT_FOUND",
  engineResult: null,
  succeeded: false,
  transactionType: null,
  account: null,
  ledgerIndex: null,
  closeTime: null,
  nftokenId: null,
  offerIndex: null,
  acceptedSellOfferIndex: null,
  explorerUrl: null,
  provenance,
});

const ledger = {
  getAccountInfo: vi.fn(async (address: string) => ({
    address,
    exists: world.account.exists,
    balanceDrops: world.account.exists ? world.account.balanceDrops : null,
    sequence: world.account.exists ? 1 : null,
    ownerCount: world.account.exists ? world.account.ownerCount : null,
    provenance,
  })),
  getReserves: vi.fn(async () => ({ baseDrops: String(1 * XRP), incrementDrops: String(0.2 * XRP) })),
  getNetworkStatus: vi.fn(async () => ({
    validatedLedger:
      world.validatedIndex === null ? null : { index: world.validatedIndex, hash: "H", ageSeconds: 1 },
  })),
  getTransaction: vi.fn(async (hash: string) => world.txs.get(hash) ?? notFound(hash)),
  getValidatedTx: vi.fn(async (hash: string): Promise<ConfirmedLedgerTx> => {
    const tx = world.txs.get(hash);
    if (!tx || tx.status !== "VALIDATED")
      throw new XrplServiceError("NOT_VALIDATED", `${hash} is not validated`);
    if (!tx.succeeded) {
      throw new XrplServiceError("TX_FAILED", `${hash} failed`, {
        rippledError: tx.engineResult ?? undefined,
      });
    }
    return {
      hash,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: tx.ledgerIndex as number,
      closeTime: tx.closeTime,
      transactionType: "NFTokenMint",
      account: ISSUER,
      nftokenId: tx.nftokenId,
      offerIndex: null,
      acceptedSellOfferIndex: null,
      explorerUrl: tx.explorerUrl as string,
    };
  }),
  verifyOwner: vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: world.nfts.has(nftokenId),
    nft: world.nfts.has(nftokenId) ? ({ uri: world.nfts.get(nftokenId) } as never) : null,
    provenance,
  })),
  getAccountMints: vi.fn(async (address: string, options: { cursor?: string } = {}) => {
    const index = options.cursor ? Number(options.cursor) : 0;
    const pages = world.pages ?? [
      { items: world.history, oldest: world.history.length > 0 || world.endlessHistory ? new Date() : null },
    ];
    const page = pages[index] ?? { items: [], oldest: new Date() };
    return {
      address,
      items: page.items,
      scanned: page.oldest ? Math.max(page.items.length, 1) : 0,
      earliestLedger: world.earliestLedger,
      oldestScanned: page.oldest ? { ledgerIndex: 5000, closeTime: page.oldest.toISOString() } : null,
      nextCursor: world.endlessHistory || index + 1 < pages.length ? String(index + 1) : null,
      provenance,
    };
  }),
  getOffers: vi.fn(async (nftokenId: string) => ({ nftokenId, sellOffers: [], buyOffers: [], provenance })),
};

const deps: MintDeps = {
  db,
  transactions: () => ({ create, get }) as never,
  ledger: () => ledger as never,
  config: { network: "TESTNET", explorerUrl: EXPLORER, networkLabel: "XRPL Testnet" },
  baseUrl: "http://localhost:3000",
};

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );
  vi.clearAllMocks();
  Object.assign(world, {
    account: { exists: true, balanceDrops: String(100 * XRP), ownerCount: 0 },
    xamanDown: false,
    history: [],
    pages: null,
    endlessHistory: false,
    earliestLedger: 1,
    validatedIndex: 6000,
  });
  world.requests.clear();
  world.forgotten.clear();
  world.txs.clear();
  world.nfts.clear();
});
afterAll(async () => {
  await db.$disconnect();
});

async function seed(totalSupply = 3, mintDeps: MintDeps = deps) {
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
  const session: AuthSession = {
    sessionId: "s",
    userId: seller.id,
    displayName: "Band",
    role: "SELLER",
    onboardedAt: new Date(),
    isDemo: true,
    method: "DEMO_PERSONA",
    expiresAt: new Date(Date.now() + 60_000),
    walletAddress: ISSUER,
    walletVerifiedAt: new Date(),
  };
  const mint = async () =>
    (await requestTicketMint(mintDeps, { session, eventId: event.id, tierId: tier.id })).ticket;
  const view = async (ticketId: string) => {
    const mints = await getEventMints(mintDeps, { session, eventId: event.id });
    return mints.tiers[0]!.tickets.find((t) => t.id === ticketId)!;
  };
  return { seller, event, tier, session, mint, view };
}

/** The request of `ticketId`'s latest attempt, as the fake Xaman holds it. */
async function latestRequest(ticketId: string): Promise<TransactionRequest> {
  const attempt = await db.ledgerTransaction.findFirstOrThrow({
    where: { relatedTicketId: ticketId },
    orderBy: { createdAt: "desc" },
  });
  return world.requests.get(attempt.signRequestRef as string) as TransactionRequest;
}

/** What Xaman says about `ticketId`'s latest request from now on. */
async function answer(
  ticketId: string,
  status: TransactionRequestStatus,
  extra: Partial<TransactionRequest> = {},
) {
  const request = await latestRequest(ticketId);
  world.requests.set(request.id, { ...request, status, ...extra });
}

/** Puts a validated mint of `ticket` on the ledger; tesSUCCESS creates its NFT. */
function onLedger(ticket: Ticket, engineResult = "tesSUCCESS") {
  world.sequence += 1;
  const hash = world.sequence.toString(16).toUpperCase().padStart(64, "0");
  const succeeded = engineResult === "tesSUCCESS";
  const nftokenId = succeeded ? nftokenIdFor(ISSUER, ticketTaxon(ticket.eventId), world.sequence) : null;
  if (nftokenId) world.nfts.set(nftokenId, ticket.metadataUri as string);
  const ledgerIndex = 5000 + world.sequence;
  world.txs.set(hash, {
    ...notFound(hash),
    status: "VALIDATED",
    engineResult,
    succeeded,
    transactionType: "NFTokenMint",
    account: ISSUER,
    ledgerIndex,
    closeTime: new Date().toISOString(),
    nftokenId,
    explorerUrl: `${EXPLORER}/transactions/${hash}`,
  });
  return { hash, nftokenId, ledgerIndex };
}

/** The seller signs `ticket`'s latest request and the ledger validates it with `engineResult`. */
async function signAndValidate(ticket: Ticket, engineResult = "tesSUCCESS") {
  const tx = onLedger(ticket, engineResult);
  const onChain = { txHash: tx.hash, engineResult, ledgerIndex: tx.ledgerIndex };
  if (engineResult === "tesSUCCESS") await answer(ticket.id, "CONFIRMED", onChain);
  else await answer(ticket.id, "FAILED", { ...onChain, failureReason: "LEDGER_REJECTED" });
  return tx;
}

/** `ticket`'s mint as the issuer's history shows it. */
function historyEntry(
  ticket: Ticket,
  tx: { hash: string; nftokenId: string | null; ledgerIndex: number },
): LedgerMint {
  return {
    hash: tx.hash,
    ledgerIndex: tx.ledgerIndex,
    closeTime: new Date().toISOString(),
    account: ISSUER,
    issuer: ISSUER,
    engineResult: "tesSUCCESS",
    succeeded: true,
    nftokenId: tx.nftokenId,
    taxon: ticketTaxon(ticket.eventId),
    uri: ticket.metadataUri,
    memos: [{ type: TICKET_MEMO_TYPE, data: ticket.id }],
    explorerUrl: `${EXPLORER}/transactions/${tx.hash}`,
  };
}

/**
 * Moves past the point where anything signed for `ticketId`'s open attempt could validate: the ledger
 * passes its LastLedgerSequence, and the attempt is older than the 15-minute fallback.
 */
async function age(ticketId: string) {
  await db.ledgerTransaction.updateMany({
    where: { relatedTicketId: ticketId, appliedAt: null },
    data: { createdAt: longAgo() },
  });
  world.validatedIndex = (world.validatedIndex ?? 6000) + MINT_LEDGER_WINDOW + 1;
}

const ticketRow = (id: string) => db.ticketNFT.findUniqueOrThrow({ where: { id } });
const mintedQuantity = async (tierId: string) =>
  (await db.ticketTier.findUniqueOrThrow({ where: { id: tierId } })).mintedQuantity;

describe("before a ticket is reserved", () => {
  it("refuses a wallet that isn't activated on the ledger, without reserving a ticket", async () => {
    const { mint } = await seed();
    world.account.exists = false;

    await expect(mint()).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/isn't activated on XRPL Testnet yet\. It needs at least 1 XRP/),
      details: { reason: "ACCOUNT_NOT_FOUND" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(await db.ticketNFT.count()).toBe(0);
  });

  it("refuses a wallet that can't keep a new NFT page's reserve, and says how much is spare", async () => {
    const { mint } = await seed();
    // 1 XRP base + 3 owned objects at 0.2 XRP, plus 0.1 XRP spare.
    world.account = { exists: true, balanceDrops: String(1.7 * XRP), ownerCount: 3 };

    await expect(mint()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(
        "a ticket can need 0.2 XRP of your wallet's reserve for a new NFT page, plus the network fee, and this wallet has 0.1 XRP spare",
      ),
      details: { reason: "INSUFFICIENT_RESERVE", requiredDrops: "201000", spendableDrops: "100000" },
    });
    expect(create).not.toHaveBeenCalled();
    expect(await db.ticketNFT.count()).toBe(0);
  });

  it("lets a wallet with just the reserve and the fee spare mint", async () => {
    const { mint } = await seed();
    world.account = { exists: true, balanceDrops: String(1.6 * XRP + 201_000), ownerCount: 3 };

    expect(await mint()).toMatchObject({ serial: 1, mintStatus: "PENDING" });
  });

  it("bounds the mint with a LastLedgerSequence, kept on the attempt until it is settled", async () => {
    const { mint } = await seed();
    const ticket = await mint();
    const deadline = 6000 + MINT_LEDGER_WINDOW;

    expect(create.mock.calls[0]![0].txjson).toMatchObject({ LastLedgerSequence: deadline });
    const attempt = () => db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } });
    expect(await attempt()).toMatchObject({ status: "PENDING", ledgerIndex: deadline });

    await answer(ticket.id, "EXPIRED");
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    expect(await attempt()).toMatchObject({ status: "DROPPED", ledgerIndex: null });
  });

  it("refuses to mint while the node has no validated ledger, without reserving a ticket", async () => {
    const { mint } = await seed();
    world.validatedIndex = null;

    await expect(mint()).rejects.toMatchObject({ code: "NODE_UNAVAILABLE" });
    expect(create).not.toHaveBeenCalled();
    expect(await db.ticketNFT.count()).toBe(0);
  });

  it("settles the tier's earlier requests first, so a declined ticket is retried straight away", async () => {
    const { mint } = await seed(1);
    const first = await mint();
    await answer(first.id, "REJECTED"); // nobody has reloaded the tickets since

    const retried = await mint();
    expect(retried).toMatchObject({ id: first.id, serial: 1, metadataUri: first.metadataUri });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("records a mint confirmed meanwhile instead of reserving its ticket again", async () => {
    const { mint, tier } = await seed(2);
    const first = await mint();
    const tx = await signAndValidate(first);

    const second = await mint();
    expect(second).toMatchObject({ serial: 2 });
    expect(second.id).not.toBe(first.id);
    expect(create.mock.calls[1]![0]).toMatchObject({ reference: second.id });
    expect(await ticketRow(first.id)).toMatchObject({ mintStatus: "MINTED", nftokenId: tx.nftokenId });
    expect(await mintedQuantity(tier.id)).toBe(1);
  });
});

describe("why a mint failed", () => {
  it.each([
    ["declined in Xaman", "REJECTED", {}, { reason: "NOT_APPROVED", resultCode: null, txExplorerUrl: null }],
    ["expired in Xaman", "EXPIRED", {}, { reason: "NOT_APPROVED", resultCode: null, txExplorerUrl: null }],
    ["cancelled", "CANCELLED", {}, { reason: "NOT_APPROVED", resultCode: null, txExplorerUrl: null }],
    [
      "refused by the network",
      "FAILED",
      { failureReason: "NETWORK_REJECTED", engineResult: "temMALFORMED", txHash: "AB".repeat(32) },
      { reason: "NOT_VALIDATED", resultCode: "temMALFORMED", txExplorerUrl: null },
    ],
    [
      "not validated in time",
      "FAILED",
      { failureReason: "NOT_VALIDATED_IN_TIME", txHash: "CD".repeat(32) },
      { reason: "NOT_VALIDATED", resultCode: null, txExplorerUrl: null },
    ],
  ] as const)("says so when it was %s", async (_label, status, extra, failure) => {
    const { mint, view, tier } = await seed();
    const ticket = await mint();
    await answer(ticket.id, status, extra);

    expect(await view(ticket.id)).toMatchObject({
      mintStatus: "FAILED",
      nftokenId: null,
      mintFailure: { ...failure, at: expect.any(String) },
    });
    expect(await mintedQuantity(tier.id)).toBe(0);
  });

  it.each([
    ["tecINSUFFICIENT_RESERVE", "INSUFFICIENT_RESERVE"],
    ["tecNO_PERMISSION", "LEDGER_REJECTED"],
  ] as const)("tells a ledger rejection with %s apart, and links it", async (engineResult, reason) => {
    const { mint, view } = await seed();
    const ticket = await mint();
    const tx = await signAndValidate(ticket, engineResult);

    expect((await view(ticket.id)).mintFailure).toEqual({
      reason,
      resultCode: engineResult,
      txExplorerUrl: `${EXPLORER}/transactions/${tx.hash}`,
      at: expect.any(String),
    });
  });

  it("says when the approval request could not be created", async () => {
    const { mint, view } = await seed();
    create.mockRejectedValueOnce(new XrplServiceError("PROVIDER_UNAVAILABLE", "Xaman is unreachable"));
    await expect(mint()).rejects.toThrow("Xaman is unreachable");

    const ticket = await db.ticketNFT.findFirstOrThrow();
    expect(ticket.mintStatus).toBe("FAILED");
    expect(
      await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } }),
    ).toMatchObject({
      status: "DROPPED",
      signRequestRef: null,
      appliedAt: expect.any(Date),
    });
    expect((await view(ticket.id)).mintFailure).toMatchObject({ reason: "REQUEST_FAILED" });
  });

  it("shows the latest attempt's reason, and none once the ticket is minted", async () => {
    const { mint, view } = await seed(1);
    const ticket = await mint();
    await answer(ticket.id, "REJECTED");
    expect((await view(ticket.id)).mintFailure).toMatchObject({ reason: "NOT_APPROVED" });

    await mint(); // retries the same ticket
    await signAndValidate(ticket, "tecINSUFFICIENT_RESERVE");
    expect((await view(ticket.id)).mintFailure).toMatchObject({ reason: "INSUFFICIENT_RESERVE" });

    await mint();
    expect((await view(ticket.id)).mintFailure).toBeNull(); // reserved again: pending
    await signAndValidate(ticket);
    expect(await view(ticket.id)).toMatchObject({ mintStatus: "MINTED", mintFailure: null });
  });
});

describe("retrying a failed mint", () => {
  it("reuses the failed ticket, with its number and metadata, and mints it once", async () => {
    const { mint, view, tier } = await seed(1);
    const ticket = await mint();
    await signAndValidate(ticket, "tecINSUFFICIENT_RESERVE");
    expect((await view(ticket.id)).mintStatus).toBe("FAILED");

    const retried = await mint();
    expect(retried).toMatchObject({ id: ticket.id, serial: 1, metadataUri: ticket.metadataUri });
    const tx = await signAndValidate(retried);
    expect(await view(ticket.id)).toMatchObject({ mintStatus: "MINTED", nftokenId: tx.nftokenId });
    expect(await mintedQuantity(tier.id)).toBe(1);

    // Both attempts are on record; only the second produced an NFT.
    const attempts = await db.ledgerTransaction.findMany({
      where: { relatedTicketId: ticket.id },
      orderBy: { createdAt: "asc" },
    });
    expect(attempts.map((a) => [a.status, a.resultCode])).toEqual([
      ["VALIDATED_FAILURE", "tecINSUFFICIENT_RESERVE"],
      ["VALIDATED_SUCCESS", "tesSUCCESS"],
    ]);
  });

  it("never reserves a minted ticket again", async () => {
    const { mint, view } = await seed(1);
    const ticket = await mint();
    await signAndValidate(ticket);
    expect((await view(ticket.id)).mintStatus).toBe("MINTED");

    await expect(mint()).rejects.toMatchObject({ status: 409 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("requests that can't be signed or followed any more", () => {
  it("frees a ticket whose request was never recorded, once it could no longer be signed", async () => {
    const { event, tier, view } = await seed(1);
    // The server stopped between reserving the ticket and recording its request.
    const { ticket } = await reserveTicketMint(db, {
      eventId: event.id,
      tierId: tier.id,
      issuerAddress: ISSUER,
      baseUrl: deps.baseUrl,
      network: "TESTNET",
      lastLedgerSequence: 6000 + MINT_LEDGER_WINDOW,
    });
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING"); // could still be in progress

    await age(ticket.id);
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    expect(await view(ticket.id)).toMatchObject({ mintFailure: { reason: "REQUEST_FAILED" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("frees a ticket reserved before attempts were recorded, with no attempt at all", async () => {
    const { event, tier } = await seed(1);
    const ticket = await createPendingTicket(db, {
      eventId: event.id,
      tierId: tier.id,
      issuerAddress: ISSUER,
      baseUrl: deps.baseUrl,
    });
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");

    await db.$executeRaw`UPDATE "TicketNFT" SET "updatedAt" = ${longAgo()} WHERE "id" = ${ticket.id}::uuid`;
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
  });

  it("frees a ticket whose unsigned request Xaman forgot, once the issuer's history shows no mint", async () => {
    const { mint } = await seed(1);
    const ticket = await mint();
    world.forgotten.add((await latestRequest(ticket.id)).id);

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING"); // too recent to judge
    await age(ticket.id);
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    expect(ledger.getAccountMints).toHaveBeenCalledWith(ISSUER, expect.anything());
    expect(
      await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } }),
    ).toMatchObject({
      status: "DROPPED",
      hash: null,
    });
    // The freed ticket is minted again on the next request.
    expect(await mint()).toMatchObject({ id: ticket.id, serial: 1 });
  });

  it("records the mint instead when the forgotten request was signed and minted", async () => {
    const { mint, tier } = await seed(1);
    const ticket = await mint();
    const tx = onLedger(ticket); // signed and validated, but Xaman lost the outcome
    world.history = [historyEntry(ticket, tx)];
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    expect(await reconcileTicketMint(deps, ticket.id)).toMatchObject({
      mintStatus: "MINTED",
      nftokenId: tx.nftokenId,
      mintTxHash: tx.hash,
    });
    expect(await mintedQuantity(tier.id)).toBe(1);
    expect(await db.ledgerTransaction.count({ where: { relatedTicketId: ticket.id } })).toBe(1);
    await expect(mint()).rejects.toMatchObject({ status: 409 }); // the tier is full: nothing is minted twice
  });

  it("leaves a ticket whose mint on the ledger doesn't match it, for the ledger check to report", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint } = await seed(1);
    const ticket = await mint();
    const tx = onLedger(ticket);
    world.history = [{ ...historyEntry(ticket, tx), uri: "https://elsewhere.example/metadata" }];
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("has a mint on the ledger that wasn't recorded"),
    );
    warn.mockRestore();
  });

  it("leaves a ticket when too many of the issuer's transactions are newer than the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint } = await seed(1);
    const ticket = await mint();
    world.endlessHistory = true; // three pages read, none reaching back to the request
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    expect(ledger.getAccountMints).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("can't rule out a mint"));
    warn.mockRestore();
  });

  it("frees a ticket as soon as the search reads back past the request, whatever it read", async () => {
    const { mint } = await seed(1);
    const ticket = await mint();
    // A long history of sales and payments from before the request, and no mint among them.
    world.pages = [{ items: [], oldest: new Date(Date.now() - 24 * 60 * 60 * 1000) }];
    world.endlessHistory = true;
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    expect(ledger.getAccountMints).toHaveBeenCalledTimes(1);
  });

  it("finds the ticket's mint on a later page, behind newer mints of other tickets", async () => {
    const { mint, tier } = await seed(1);
    const ticket = await mint();
    const tx = onLedger(ticket); // signed and validated, but Xaman lost the outcome
    const otherTicketsMint = () => {
      world.sequence += 1;
      return historyEntry(
        { ...ticket, id: randomUUID() },
        {
          hash: world.sequence.toString(16).toUpperCase().padStart(64, "9"),
          nftokenId: nftokenIdFor(ISSUER, ticketTaxon(ticket.eventId), world.sequence),
          ledgerIndex: 5500,
        },
      );
    };
    world.pages = [
      { items: [otherTicketsMint(), otherTicketsMint(), otherTicketsMint()], oldest: new Date() },
      { items: [historyEntry(ticket, tx)], oldest: new Date() },
    ];
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    expect(await reconcileTicketMint(deps, ticket.id)).toMatchObject({
      mintStatus: "MINTED",
      nftokenId: tx.nftokenId,
      mintTxHash: tx.hash,
    });
    expect(ledger.getAccountMints).toHaveBeenCalledTimes(2);
    expect(await mintedQuantity(tier.id)).toBe(1);
  });

  it("leaves a ticket when the node's history starts after the request, so it can't show a mint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint } = await seed(1);
    const ticket = await mint();
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);
    // A node that keeps only recent ledgers: an empty search proves nothing about the request's ledgers.
    world.earliestLedger = 6000 + MINT_LEDGER_WINDOW - 10;

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    world.earliestLedger = null; // nor does a node that doesn't say
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");

    world.earliestLedger = 1; // a node with the whole history settles it
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    warn.mockRestore();
  });

  describe("a forgotten request that was signed (its hash was recorded)", () => {
    async function signedThenForgotten() {
      const seeded = await seed(1);
      const ticket = await seeded.mint();
      const hash = "EF".repeat(32);
      await answer(ticket.id, "SUBMITTED", { txHash: hash });
      expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("SUBMITTED");
      world.forgotten.add((await latestRequest(ticket.id)).id);
      await age(ticket.id);
      return { ...seeded, ticket, hash };
    }

    it("is minted when its transaction validated", async () => {
      const { ticket, hash, tier } = await signedThenForgotten();
      const tx = onLedger(ticket);
      world.txs.set(hash, {
        ...world.txs.get(tx.hash)!,
        hash,
        explorerUrl: `${EXPLORER}/transactions/${hash}`,
      });

      expect(await reconcileTicketMint(deps, ticket.id)).toMatchObject({
        mintStatus: "MINTED",
        mintTxHash: hash,
      });
      expect(await mintedQuantity(tier.id)).toBe(1);
    });

    it("fails with the ledger's result when its transaction was rejected", async () => {
      const { ticket, hash, view } = await signedThenForgotten();
      world.txs.set(hash, {
        ...notFound(hash),
        status: "VALIDATED",
        engineResult: "tecINSUFFICIENT_RESERVE",
        ledgerIndex: 5100,
        explorerUrl: `${EXPLORER}/transactions/${hash}`,
      });

      expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
      expect((await view(ticket.id)).mintFailure).toMatchObject({
        reason: "INSUFFICIENT_RESERVE",
        resultCode: "tecINSUFFICIENT_RESERVE",
      });
    });

    it("is freed when its transaction never reached a ledger", async () => {
      const { ticket, view } = await signedThenForgotten();

      expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
      expect((await view(ticket.id)).mintFailure).toMatchObject({ reason: "NOT_VALIDATED" });
      // The issuer's history was checked too, in case this node no longer keeps the transaction.
      expect(ledger.getAccountMints).toHaveBeenCalled();
    });

    it("is minted from the issuer's history when the node no longer has the transaction itself", async () => {
      const { ticket, hash, tier } = await signedThenForgotten();
      const tx = onLedger(ticket);
      world.txs.delete(tx.hash); // the lookup by hash finds nothing
      world.history = [historyEntry(ticket, { ...tx, hash })];
      world.txs.set(hash, notFound(hash));

      expect(await reconcileTicketMint(deps, ticket.id)).toMatchObject({
        mintStatus: "MINTED",
        nftokenId: tx.nftokenId,
        mintTxHash: hash,
      });
      expect(await mintedQuantity(tier.id)).toBe(1);
      expect(await db.ledgerTransaction.count({ where: { relatedTicketId: ticket.id } })).toBe(1);
    });

    it("waits when the node keeps too little history to say it never validated", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { ticket } = await signedThenForgotten();
      world.earliestLedger = 6000 + MINT_LEDGER_WINDOW;

      expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("SUBMITTED");
      warn.mockRestore();
    });

    it("waits while its transaction is in a ledger that isn't validated yet", async () => {
      const { ticket, hash } = await signedThenForgotten();
      world.txs.set(hash, { ...notFound(hash), status: "PENDING" });

      expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("SUBMITTED");
    });
  });

  it("keeps waiting while Xaman is unreachable, however old the request", async () => {
    const { mint } = await seed(1);
    const ticket = await mint();
    await age(ticket.id);
    world.xamanDown = true;

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    expect(ledger.getAccountMints).not.toHaveBeenCalled();
  });

  it("waits for the ledger to pass a forgotten request's LastLedgerSequence, however old the request", async () => {
    const { mint } = await seed(1);
    const ticket = await mint();
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await db.ledgerTransaction.updateMany({
      where: { relatedTicketId: ticket.id },
      data: { createdAt: longAgo() }, // old, but the ledger hasn't moved
    });

    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    world.validatedIndex = 6000 + MINT_LEDGER_WINDOW + 1;
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
  });

  it("falls back to 15 minutes for an attempt recorded without a LastLedgerSequence", async () => {
    const { event, tier } = await seed(1);
    const ticket = await createPendingTicket(db, {
      eventId: event.id,
      tierId: tier.id,
      issuerAddress: ISSUER,
      baseUrl: deps.baseUrl,
    });
    // As requestTicketMint recorded it before XRPL-027; Xaman no longer has the request.
    const attempt = await db.ledgerTransaction.create({
      data: {
        type: "NFTokenMint",
        status: "PENDING",
        account: ISSUER,
        signRequestRef: randomUUID(),
        relatedTicketId: ticket.id,
      },
    });
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    expect(ledger.getAccountMints).not.toHaveBeenCalled(); // too recent to look yet

    // With no LastLedgerSequence there is no ledger to measure the node's history against, so only
    // reading a transaction from before the request rules a mint out.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.ledgerTransaction.update({ where: { id: attempt.id }, data: { createdAt: longAgo() } });
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("PENDING");
    world.pages = [{ items: [], oldest: new Date(Date.now() - 24 * 60 * 60 * 1000) }];
    expect((await reconcileTicketMint(deps, ticket.id)).mintStatus).toBe("FAILED");
    warn.mockRestore();
  });

  it("lets a tier filled only by requests nobody can sign be minted again", async () => {
    const { mint } = await seed(1);
    const ticket = await mint();
    world.forgotten.add((await latestRequest(ticket.id)).id);
    await age(ticket.id);

    // No page reload in between: the next mint settles the tier first.
    expect(await mint()).toMatchObject({ id: ticket.id, serial: 1 });
  });
});

describe("inventory after a partial failure", () => {
  it("keeps the tier's counts consistent through a failed run and its retry", async () => {
    const { mint, view, event, session, tier } = await seed(3);

    const first = await mint();
    await signAndValidate(first);
    const second = await mint(); // settles #1 first
    await signAndValidate(second, "tecINSUFFICIENT_RESERVE"); // the run stops here
    expect((await view(second.id)).mintStatus).toBe("FAILED");
    expect(await mintedQuantity(tier.id)).toBe(1);

    // Starting again retries #2, then mints #3.
    const retry = await mint();
    expect(retry).toMatchObject({ id: second.id, serial: 2 });
    await signAndValidate(retry);
    const third = await mint();
    expect(third).toMatchObject({ serial: 3 });
    await signAndValidate(third);

    const mints = await getEventMints(deps, { session, eventId: event.id });
    const tickets = mints.tiers[0]!.tickets;
    expect(tickets.map((t) => [t.serial, t.mintStatus])).toEqual([
      [1, "MINTED"],
      [2, "MINTED"],
      [3, "MINTED"],
    ]);
    expect(mints.tiers[0]!.mintedQuantity).toBe(3);
    expect(new Set(tickets.map((t) => t.nftokenId)).size).toBe(3);
    // One successful mint per ticket, never two.
    const successes = await db.ledgerTransaction.groupBy({
      by: ["relatedTicketId"],
      where: { type: "NFTokenMint", status: "VALIDATED_SUCCESS" },
      _count: { _all: true },
    });
    expect(successes.map((s) => s._count._all)).toEqual([1, 1, 1]);
    await expect(mint()).rejects.toMatchObject({ status: 409 });
  });
});

describe("a request opened in Xaman before it expired", () => {
  // The app's real request service over a fake Xaman, so the LastLedgerSequence the mint code writes is
  // the one the request service reads back.
  type Payload = { input: CreatePayloadInput; meta: Partial<XamanPayloadResult["meta"]> };
  const payloads = new Map<string, Payload>();
  const xaman = {
    createPayload: vi.fn(async (input: CreatePayloadInput) => {
      const uuid = randomUUID();
      payloads.set(uuid, { input, meta: {} });
      return { uuid, next: { always: "" }, refs: { qr_png: "", websocket_status: "" }, pushed: false };
    }),
    getPayload: vi.fn(async (uuid: string): Promise<XamanPayloadResult> => {
      const stored = payloads.get(uuid);
      if (!stored) throw new XrplServiceError("NOT_FOUND", "Sign request not found");
      return {
        meta: {
          exists: true,
          uuid,
          resolved: false,
          signed: false,
          cancelled: false,
          expired: false,
          app_opened: false,
          force_network: "TESTNET",
          ...stored.meta,
        },
        payload: {
          tx_type: String(stored.input.txjson.TransactionType),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          request_json: stored.input.txjson,
        },
        response: {
          account: null,
          hex: null,
          txid: null,
          environment_nodetype: null,
          dispatched_result: null,
          resolved_at: null,
        },
        custom_meta: stored.input.custom_meta as XamanPayloadResult["custom_meta"],
      };
    }),
    cancelPayload: vi.fn(async () => ({ cancelled: false, reason: "ALREADY_OPENED" })),
  };
  const requests = new WalletTransactionRequests(
    loadXrplConfig({}),
    xaman as unknown as XamanClient,
    ledger as never,
  );
  const realDeps: MintDeps = { ...deps, transactions: () => requests };

  beforeEach(() => payloads.clear());

  /** Mints the only ticket of a tier, then the seller opens the request and Xaman's expiry passes. */
  async function openedThenExpired(meta: Partial<XamanPayloadResult["meta"]> = {}) {
    const seeded = await seed(1, realDeps);
    const ticket = await seeded.mint();
    const attempt = await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticket.id } });
    const payload = payloads.get(attempt.signRequestRef as string) as Payload;
    payload.meta = { app_opened: true, expired: true, ...meta };
    return { ...seeded, ticket, attempt, payload };
  }

  it("holds its ticket until the mint's LastLedgerSequence passes, then the retry reuses it", async () => {
    const { ticket, attempt, payload, mint, view } = await openedThenExpired();
    const deadline = 6000 + MINT_LEDGER_WINDOW;
    expect(payload.input.txjson.LastLedgerSequence).toBe(deadline);
    expect(attempt.ledgerIndex).toBe(deadline);

    // In the last ledger a signature could still validate in, the request is still open.
    world.validatedIndex = deadline;
    expect(await requests.get(attempt.signRequestRef as string)).toMatchObject({
      status: "OPENED",
      expiresAt: null,
    });
    expect((await reconcileTicketMint(realDeps, ticket.id)).mintStatus).toBe("PENDING");
    expect((await view(ticket.id)).mintStatus).toBe("PENDING");
    await expect(mint()).rejects.toMatchObject({ status: 409 }); // the tier's only ticket is still held
    expect(xaman.createPayload).toHaveBeenCalledTimes(1);

    // Past it, nothing signed for the first request can validate: the retry reuses the ticket.
    world.validatedIndex = deadline + 1;
    expect(await mint()).toMatchObject({ id: ticket.id, serial: 1 });
    expect(xaman.createPayload).toHaveBeenCalledTimes(2);
    expect(await db.ledgerTransaction.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({
      status: "DROPPED",
      ledgerIndex: null,
    });
  });

  it("frees the ticket at once when the seller declines it after Xaman's expiry", async () => {
    const { ticket, mint, view } = await openedThenExpired({ resolved: true });

    expect(await view(ticket.id)).toMatchObject({
      mintStatus: "FAILED",
      mintFailure: { reason: "NOT_APPROVED" },
    });
    expect(await mint()).toMatchObject({ id: ticket.id, serial: 1 });
  });

  it("frees the ticket at once when the request expired without being opened", async () => {
    const { ticket, payload, mint } = await openedThenExpired();
    payload.meta = { expired: true };

    expect(await mint()).toMatchObject({ id: ticket.id, serial: 1 });
  });
});
