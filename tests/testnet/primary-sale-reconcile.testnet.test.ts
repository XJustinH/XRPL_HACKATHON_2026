import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getPrimaryAvailability } from "@/lib/inventory/primary-inventory";
import { reconcileLedgerTransaction, type SalesDeps } from "@/lib/inventory/sales";
import { createXrplQueryService } from "@/lib/xrpl";
import { reconcilePrimaryOffer, requestPrimaryOffer, type OfferDeps } from "@/lib/xrpl/offers/primary";
import { reconcileTicketMint, requestTicketMint, type MintDeps } from "@/lib/xrpl/tickets/minting";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * XRPL-032 on live XRPL Testnet: a primary sale made **outside the app** is recorded from its validated
 * transaction hash, exactly once. Run on demand with `npm run test:testnet` (see README.md).
 *
 * The seller mints and lists through the app (approvals by AutoApproveXaman, as in the lifecycle suite).
 * The buyer then accepts the sell offer straight on the ledger with their own wallet, as another wallet
 * app would, so the app's purchase flow never sees the sale. Only the transaction hash reaches the app.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);
const sales: SalesDeps = { db, ledger: () => ledger };

let seller: TestWallet;
let buyer: TestWallet;
let mintDeps: MintDeps;
let offerDeps: OfferDeps;
let sellerId: string;
let eventId: string;
let tierId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  // Only the seller approves through "Xaman": the buyer never uses the app.
  const xaman = new AutoApproveXaman(connection, config.network, [seller]);
  mintDeps = {
    db,
    transactions: () => createWalletTransactionRequests(config, xaman, ledger),
    ledger: () => ledger,
    config,
    baseUrl: "http://localhost:3000",
  };
  offerDeps = { db, transactions: mintDeps.transactions, ledger: () => ledger, config };

  const user = await db.user.create({
    data: { displayName: "Outside-sale test seller", role: "SELLER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: user.id,
      title: "Outside-sale test event",
      startsAt: new Date("2027-06-01T20:00:00.000Z"),
      venue: "Test venue",
      city: "Dublin",
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "General Admission", priceDrops: "1000000", totalSupply: 1 },
  });
  sellerId = user.id;
  eventId = event.id;
  tierId = tier.id;
});

afterAll(async () => {
  await ledger.close();
  await connection.disconnect();
  await db.$disconnect();
});

/** A signed-in seller whose wallet control is already proven (XRPL-012 is tested separately). */
function sellerSession(): AuthSession {
  return {
    sessionId: "outside-sale-test",
    userId: sellerId,
    displayName: "Outside-sale test seller",
    role: "SELLER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    walletAddress: seller.classicAddress,
    walletVerifiedAt: new Date(),
  };
}

describe("recording a sale made outside the app on XRPL Testnet (XRPL-032)", () => {
  let ticketId: string;
  let nftokenId: string;
  let offerId: string;
  let offerIndex: string;
  let saleHash: string;

  it("lists the event's only ticket for sale, confirmed on the ledger", async () => {
    const { ticket } = await requestTicketMint(mintDeps, { session: sellerSession(), eventId, tierId });
    ticketId = ticket.id;
    const minted = await waitFor(
      () => reconcileTicketMint(mintDeps, ticketId),
      (t) => t.mintStatus === "MINTED" || t.mintStatus === "FAILED",
      { what: "the mint to reach a validated ledger" },
    );
    expect(minted.mintStatus).toBe("MINTED");
    nftokenId = minted.nftokenId as string;

    const { offer } = await requestPrimaryOffer(offerDeps, { session: sellerSession(), ticketId });
    offerId = offer.id;
    const listed = await waitFor(
      () => reconcilePrimaryOffer(offerDeps, offerId),
      (o) => o.state !== "PENDING_SIGNATURE",
      { what: "the sell offer to reach a validated ledger" },
    );
    expect(listed.state).toBe("ACTIVE");
    offerIndex = listed.offerIndex as string;

    expect(await getPrimaryAvailability(db, eventId)).toMatchObject({ sold: 0, remaining: 1, isSoldOut: false });
  });

  it("records the sale from its validated transaction: offer, ticket, buyer and tx details", async () => {
    // The buyer accepts the offer from their own wallet, bypassing the app entirely.
    const submitted = await connection.withClient(
      ({ client }) =>
        client.submitAndWait(
          { TransactionType: "NFTokenAcceptOffer", Account: buyer.classicAddress, NFTokenSellOffer: offerIndex },
          { autofill: true, wallet: buyer },
        ),
      "outside-the-app purchase",
    );
    saleHash = submitted.result.hash;
    // The app knows nothing of the sale yet.
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({ state: "ACTIVE" });

    const result = await reconcileLedgerTransaction(sales, saleHash);
    expect(result).toEqual({
      outcome: "APPLIED",
      kind: "PRIMARY_SALE",
      offerId,
      ticketId,
      acceptedByAddress: buyer.classicAddress,
    });

    // What the app read: the ledger's own record of the sale, which took the app's sell offer.
    const onLedger = await ledger.getValidatedTx(saleHash);
    expect(onLedger).toMatchObject({
      validated: true,
      result: "tesSUCCESS",
      transactionType: "NFTokenAcceptOffer",
      account: buyer.classicAddress,
      nftokenId,
      offerIndex: null,
      acceptedSellOfferIndex: offerIndex,
    });

    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: offerId } })).toMatchObject({
      state: "ACCEPTED",
      acceptTxHash: saleHash,
      acceptedByAddress: buyer.classicAddress,
    });
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket).toMatchObject({
      primarySaleTxHash: saleHash,
      cachedOwnerAddress: buyer.classicAddress,
      ownerSyncStatus: "SYNCED",
    });
    expect(ticket.primarySoldAt?.toISOString()).toBe(new Date(onLedger.closeTime as string).toISOString());
    const recorded = await db.ledgerTransaction.findUniqueOrThrow({ where: { hash: saleHash } });
    expect(recorded).toMatchObject({
      type: "NFTokenAcceptOffer",
      status: "VALIDATED_SUCCESS",
      resultCode: "tesSUCCESS",
      account: buyer.classicAddress,
      ledgerIndex: onLedger.ledgerIndex,
      relatedOfferId: offerId,
    });
    expect(recorded.appliedAt).not.toBeNull();

    // The ledger agrees: the buyer holds the NFT and the seller no longer does.
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
    expect((await ledger.verifyOwner(nftokenId, seller.classicAddress)).owns).toBe(false);

    // The event's only ticket is sold, so it is sold out.
    expect(await getPrimaryAvailability(db, eventId)).toMatchObject({ sold: 1, remaining: 0, isSoldOut: true });
  });

  it("counts the sale once when the same transaction is reported again", async () => {
    const before = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });

    const repeats = await Promise.all([
      reconcileLedgerTransaction(sales, saleHash),
      reconcileLedgerTransaction(sales, saleHash),
    ]);
    for (const repeat of repeats) {
      expect(repeat).toEqual({ outcome: "ALREADY_APPLIED", kind: "PRIMARY_SALE", offerId, ticketId });
    }

    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } })).toEqual(before);
    expect(await db.ledgerTransaction.count({ where: { hash: saleHash } })).toBe(1);
    expect(await getPrimaryAvailability(db, eventId)).toMatchObject({ sold: 1, remaining: 0, isSoldOut: true });
  });
});
