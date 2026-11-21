import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createXrplQueryService } from "@/lib/xrpl";
import { requestHolderOffer } from "@/lib/xrpl/offers/holder";
import { listPrimaryOffers, reconcilePrimaryOffer, requestPrimaryOffer, type OfferDeps } from "@/lib/xrpl/offers/primary";
import { getOfferStatus, requestPurchase, type PurchaseDeps } from "@/lib/xrpl/offers/purchase";
import { reconcileTicketMint, requestTicketMint, type MintDeps } from "@/lib/xrpl/tickets/minting";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { createWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";
import { CheckInService } from "@/features/checkin/checkin-service";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { PrismaCheckInStore, PrismaTicketDirectory } from "@/features/checkin/prisma-store";
import { XamanCheckInProofs } from "@/features/checkin/xaman-proof";
import { XrplLedgerOwnership } from "@/features/checkin/xrpl-ownership";
import { getEventInventory } from "@/features/organiser/inventory";
import { getEventMetrics } from "@/features/organiser/metrics";
import { PrismaAttendance } from "@/features/reviews/attendance";
import { PrismaReviewStore } from "@/features/reviews/prisma-store";
import { ReviewService } from "@/features/reviews/review-service";
import { createInventoryPort } from "@/lib/inventory/primary-inventory";
import { PrismaResaleOffers, prismaPolicyEvents } from "@/lib/resale-policy/prisma-adapters";
import { ResalePolicy } from "@/lib/resale-policy/resale-policy";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * XRPL-050: the ticket lifecycle against live XRPL Testnet. Run on demand with `npm run test:testnet`
 * (needs the internet and `npm run db:up`; never part of CI). See tests/testnet/README.md.
 *
 * Real: the app's services, the *_test database, XRPL Testnet and its faucet.
 * Stood in for: the person approving in Xaman (AutoApproveXaman signs with a throwaway wallet, both
 * transactions and check-in sign-ins), and the session's wallet sign-in proof (XRPL-012, covered by its
 * own tests): sessions start with the throwaway wallet as their proven wallet.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);

let seller: TestWallet;
let buyer: TestWallet;
let friend: TestWallet;
let xaman: AutoApproveXaman;
let deps: MintDeps;
let offerDeps: OfferDeps;
let purchaseDeps: PurchaseDeps;
let sellerId: string;
let buyerId: string;
let friendId: string;
let eventId: string;
let tierId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  friend = await fundTestWallet(connection, config);
  xaman = new AutoApproveXaman(connection, config.network, [seller, buyer, friend]);
  deps = {
    db,
    transactions: () => createWalletTransactionRequests(config, xaman, ledger),
    ledger: () => ledger,
    config,
    // Metadata URIs written on Testnet point here. Not publicly reachable, which only affects how
    // wallets and explorers display the NFT, not its validity.
    baseUrl: "http://localhost:3000",
  };
  offerDeps = { db, transactions: deps.transactions, ledger: () => ledger, config };
  purchaseDeps = { db, transactions: deps.transactions, ledger: () => ledger, config };

  const user = await db.user.create({
    data: { displayName: "Lifecycle test seller", role: "SELLER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: user.id,
      title: "Lifecycle test event",
      startsAt: new Date("2027-06-01T20:00:00.000Z"),
      venue: "Test venue",
      city: "Dublin",
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "General Admission", priceDrops: "1000000", totalSupply: 2 },
  });
  sellerId = user.id;
  buyerId = (
    await db.user.create({ data: { displayName: "Lifecycle test buyer", role: "CUSTOMER", onboardedAt: new Date() } })
  ).id;
  friendId = (
    await db.user.create({ data: { displayName: "Lifecycle test friend", role: "CUSTOMER", onboardedAt: new Date() } })
  ).id;
  eventId = event.id;
  tierId = tier.id;
});

afterAll(async () => {
  await ledger.close();
  await connection.disconnect();
  await db.$disconnect();
});

/** A signed-in seller whose wallet control is already proven (XRPL-012 is tested separately). */
/** A signed-in customer whose wallet control is already proven. */
function buyerSession(): AuthSession {
  return {
    sessionId: "lifecycle-test-buyer",
    userId: buyerId,
    displayName: "Lifecycle test buyer",
    role: "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    walletAddress: buyer.classicAddress,
    walletVerifiedAt: new Date(),
  };
}

/** A signed-in customer (the buyer's friend) whose wallet control is already proven. */
function friendSession(): AuthSession {
  return { ...buyerSession(), sessionId: "lifecycle-test-friend", userId: friendId, displayName: "Lifecycle test friend", walletAddress: friend.classicAddress };
}

function sellerSession(): AuthSession {
  return {
    sessionId: "lifecycle-test",
    userId: sellerId,
    displayName: "Lifecycle test seller",
    role: "SELLER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    walletAddress: seller.classicAddress,
    walletVerifiedAt: new Date(),
  };
}

describe("ticket lifecycle on XRPL Testnet (XRPL-050)", () => {
  let ticketId: string;
  let nftokenId: string;
  let metadataUri: string;
  let offerId: string;
  let offerIndex: string;

  it("mints a ticket NFT and records it only from the validated ledger outcome", async () => {
    const { ticket } = await requestTicketMint(deps, { session: sellerSession(), eventId, tierId });
    ticketId = ticket.id;
    expect(xaman.approved).toHaveLength(1);
    expect(xaman.approved[0]?.txjson).toMatchObject({
      TransactionType: "NFTokenMint",
      Account: seller.classicAddress,
    });

    const minted = await waitFor(
      () => reconcileTicketMint(deps, ticketId),
      (t) => t.mintStatus === "MINTED" || t.mintStatus === "FAILED",
      { what: "the mint to reach a validated ledger" },
    );
    expect(minted.mintStatus).toBe("MINTED");
    expect(minted.nftokenId).toMatch(/^[0-9A-F]{64}$/);
    expect(minted.mintTxHash).toBe(xaman.approved[0]?.hash);
    nftokenId = minted.nftokenId as string;
    metadataUri = minted.metadataUri as string;

    // The ledger itself confirms the mint.
    const tx = await ledger.getValidatedTx(minted.mintTxHash as string);
    expect(tx).toMatchObject({
      validated: true,
      result: "tesSUCCESS",
      transactionType: "NFTokenMint",
      account: seller.classicAddress,
      nftokenId,
    });

    // Recorded exactly once, even when reconciled again.
    await reconcileTicketMint(deps, ticketId);
    const tier = await db.ticketTier.findUniqueOrThrow({ where: { id: tierId } });
    expect(tier.mintedQuantity).toBe(1);
    const recorded = await db.ledgerTransaction.findFirstOrThrow({ where: { relatedTicketId: ticketId } });
    expect(recorded).toMatchObject({ status: "VALIDATED_SUCCESS", hash: minted.mintTxHash });
    expect(recorded.appliedAt).not.toBeNull();
  });

  it("finds the minted ticket in the seller's wallet on the ledger", async () => {
    const ownership = await ledger.verifyOwner(nftokenId, seller.classicAddress);

    expect(ownership.owns).toBe(true);
    expect(ownership.nft).toMatchObject({
      issuer: seller.classicAddress,
      transferable: true,
      uri: metadataUri,
    });
  });

  it("lists the ticket for sale at its tier price, confirmed on the ledger", async () => {
    const { offer } = await requestPrimaryOffer(offerDeps, { session: sellerSession(), ticketId });
    offerId = offer.id;
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      TransactionType: "NFTokenCreateOffer",
      Account: seller.classicAddress,
      NFTokenID: nftokenId,
      Amount: "1000000",
    });
    expect(xaman.approved.at(-1)?.txjson).not.toHaveProperty("Destination");

    const listed = await waitFor(
      () => reconcilePrimaryOffer(offerDeps, offer.id),
      (o) => o.state !== "PENDING_SIGNATURE",
      { what: "the sell offer to reach a validated ledger" },
    );
    expect(listed).toMatchObject({
      state: "ACTIVE",
      kind: "PRIMARY",
      ownerAddress: seller.classicAddress,
      amountDrops: "1000000",
      destinationAddress: null,
      createTxHash: xaman.approved.at(-1)?.hash,
    });
    expect(listed.offerIndex).toMatch(/^[0-9A-F]{64}$/);
    offerIndex = listed.offerIndex as string;

    // The ledger holds the same open sell offer: anyone may buy it at the tier price.
    const onLedger = await ledger.getOffers(nftokenId);
    expect(onLedger.sellOffers).toContainEqual(
      expect.objectContaining({
        offerIndex: listed.offerIndex,
        owner: seller.classicAddress,
        amountDrops: "1000000",
        destination: null,
      }),
    );

    // Buyers see it in the event's public listing.
    expect(await listPrimaryOffers(db, eventId)).toEqual([
      expect.objectContaining({
        offerId: offer.id,
        offerIndex: listed.offerIndex,
        ticketId,
        sellerAddress: seller.classicAddress,
        amountDrops: "1000000",
      }),
    ]);
  });

  it("a buyer accepts the offer and becomes the owner on the ledger", async () => {
    const { request } = await requestPurchase(purchaseDeps, { session: buyerSession(), offerId });
    expect(request.purpose).toBe("ACCEPT_PRIMARY_OFFER");
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      TransactionType: "NFTokenAcceptOffer",
      Account: buyer.classicAddress,
      NFTokenSellOffer: offerIndex,
    });

    const settled = await waitFor(
      () => getOfferStatus(purchaseDeps, offerId),
      (status) => !status.purchasePending && status.offer.state !== "ACTIVE",
      { what: "the purchase to reach a validated ledger" },
    );
    expect(settled.offer).toMatchObject({ state: "ACCEPTED", acceptTxHash: xaman.approved.at(-1)?.hash });
    expect(settled.soldAt).not.toBeNull();

    // Recorded from the validated ledger: sold, with the buyer as the cached owner.
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.primarySoldAt).not.toBeNull();
    expect(ticket.cachedOwnerAddress).toBe(buyer.classicAddress);
    const offer = await db.nFTOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.acceptedByAddress).toBe(buyer.classicAddress);

    // The ledger swapped the NFT: the buyer holds it, the seller doesn't, and the offer is gone.
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
    expect((await ledger.verifyOwner(nftokenId, seller.classicAddress)).owns).toBe(false);
    const offers = await ledger.getOffers(nftokenId);
    expect(offers.sellOffers.map((o) => o.offerIndex)).not.toContain(offerIndex);

    // A sold ticket is no longer listed for buyers.
    expect(await listPrimaryOffers(db, eventId)).toEqual([]);
  });

  it("the buyer sells privately to a friend, who gives it back as a gift; only the named wallet can accept (XRPL-040, 041)", async () => {
    const settled = (offerId: string, what: string) =>
      waitFor(
        () => getOfferStatus(purchaseDeps, offerId),
        (s) => s.offer.state !== "PENDING_SIGNATURE" && !s.purchasePending,
        { what },
      );

    // 1. A private sale: the offer names the friend's wallet as its only possible buyer.
    const privateSale = await requestHolderOffer(offerDeps, {
      session: buyerSession(),
      ticketId,
      offer: { kind: "PRIVATE", amountDrops: "1500000", destination: friend.classicAddress },
    });
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      TransactionType: "NFTokenCreateOffer",
      Account: buyer.classicAddress,
      Amount: "1500000",
      Destination: friend.classicAddress,
    });
    const listed = await settled(privateSale.offer.id, "the private offer to reach a validated ledger");
    expect(listed.offer).toMatchObject({ state: "ACTIVE", kind: "PRIVATE", destinationAddress: friend.classicAddress });
    const privateIndex = listed.offer.offerIndex as string;
    expect((await ledger.getOffers(nftokenId)).sellOffers).toContainEqual(
      expect.objectContaining({ offerIndex: privateIndex, amountDrops: "1500000", destination: friend.classicAddress }),
    );

    // Any other wallet is refused: the app hides the offer, and the ledger itself rejects a direct attempt.
    await expect(requestPurchase(purchaseDeps, { session: sellerSession(), offerId: privateSale.offer.id })).rejects.toMatchObject({
      status: 404,
    });
    await xaman.createPayload({
      txjson: { TransactionType: "NFTokenAcceptOffer", Account: seller.classicAddress, NFTokenSellOffer: privateIndex },
    });
    const attempt = xaman.approved.at(-1)?.hash as string;
    const refused = await waitFor(() => ledger.getTransaction(attempt), (t) => t.status === "VALIDATED", {
      what: "the other wallet's attempt to reach a validated ledger",
    });
    expect(refused.succeeded).toBe(false);
    expect(refused.engineResult).toMatch(/^tec/);
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);

    // The friend accepts and becomes the owner on the ledger.
    await requestPurchase(purchaseDeps, { session: friendSession(), offerId: privateSale.offer.id });
    expect((await settled(privateSale.offer.id, "the private sale to reach a validated ledger")).offer.state).toBe("ACCEPTED");
    expect((await ledger.verifyOwner(nftokenId, friend.classicAddress)).owns).toBe(true);
    expect((await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } })).cachedOwnerAddress).toBe(friend.classicAddress);

    // 2. A gift back: zero price, and only the buyer's wallet can accept it.
    const gift = await requestHolderOffer(offerDeps, {
      session: friendSession(),
      ticketId,
      offer: { kind: "GIFT", destination: buyer.classicAddress },
    });
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      Account: friend.classicAddress,
      Amount: "0",
      Destination: buyer.classicAddress,
    });
    expect((await settled(gift.offer.id, "the gift offer to reach a validated ledger")).offer.state).toBe("ACTIVE");
    await requestPurchase(purchaseDeps, { session: buyerSession(), offerId: gift.offer.id });
    expect((await settled(gift.offer.id, "the gift to reach a validated ledger")).offer.state).toBe("ACCEPTED");

    // The buyer holds the ticket again; the primary sale record is unchanged.
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.cachedOwnerAddress).toBe(buyer.classicAddress);
    expect(ticket.primarySoldAt).not.toBeNull();
  });
  it("the current holder checks in once, and a second check-in is rejected (XRPL-044 to XRPL-047)", async () => {
    // The app's check-in service, with the real store, Agent B's live ledger reads and Agent A's blob check.
    const signIns = createWalletSignRequests(config, xaman);
    const proofs = new XamanCheckInProofs(() => signIns, randomBytes(32).toString("base64url"));
    const checkIn = new CheckInService(
      {
        tickets: new PrismaTicketDirectory(db),
        organisers: new EventSellerAccess(db),
        ledger: new XrplLedgerOwnership(ledger),
        proofs,
        store: new PrismaCheckInStore(db),
      },
      { qrSecret: randomBytes(32).toString("base64url") },
    );
    const gate = (qrPayload: string) => ({ qrPayload, organiserId: sellerId, gateEventId: eventId });
    const approveIn = async (wallet: TestWallet, challengeId: string) => {
      xaman.signInWith(wallet);
      const request = await signIns.createSignIn();
      return checkIn.proveControl({ challengeId, proof: proofs.tokenFor(challengeId, request.id) });
    };

    // The seller sold the ticket, so the ledger says their wallet can't get a door code for it.
    expect(await checkIn.issueChallenge({ ticketId, walletAddress: seller.classicAddress })).toMatchObject({
      status: "WRONG_OWNER",
    });

    const code = await checkIn.issueChallenge({ ticketId, walletAddress: buyer.classicAddress });
    if (!("challengeId" in code)) throw new Error(`Expected a check-in code, got ${code.status}`);
    expect(code.qrPayload).not.toContain(buyer.classicAddress);

    // A code nobody approved in their wallet (a screenshot, say) gets nobody in.
    expect(await checkIn.verifyScan(gate(code.qrPayload))).toMatchObject({ status: "PROOF_REQUIRED" });
    // Another wallet can't approve the holder's code.
    expect(await approveIn(seller, code.challengeId)).toMatchObject({ status: "INVALID_PROOF" });
    // The holder approves in "Xaman". The signed sign-in blob is verified, not just Xaman's answer.
    expect(await approveIn(buyer, code.challengeId)).toEqual({ status: "PROVEN", challengeId: code.challengeId });
    expect(xaman.signIns.map((s) => s.account)).toEqual([seller.classicAddress, buyer.classicAddress]);

    // At the door, ownership is read from a validated Testnet ledger.
    const scanned = await checkIn.verifyScan(gate(code.qrPayload));
    if (scanned.status !== "VERIFIED") throw new Error(`Expected VERIFIED, got ${scanned.status}: ${scanned.message}`);
    expect(scanned).toMatchObject({ ticketId, eventId, nftokenId, ownerAddress: buyer.classicAddress });
    expect(scanned.ledgerIndex).toBeGreaterThan(0);

    expect(await checkIn.admit(gate(code.qrPayload))).toMatchObject({ status: "ADMITTED", ticketId, eventId });
    // Scanning the same code again is refused, and so is a fresh code for the used ticket.
    expect(await checkIn.admit(gate(code.qrPayload))).toMatchObject({ status: "ALREADY_USED" });
    expect(await checkIn.issueChallenge({ ticketId, walletAddress: buyer.classicAddress })).toMatchObject({
      status: "ALREADY_USED",
    });

    const records = await db.checkInRecord.findMany({ where: { ticketId } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ eventId, walletAddress: buyer.classicAddress, organiserId: sellerId });
    expect(records[0]?.verifiedLedgerIndex).toBeGreaterThan(0);
  });

  it("the organiser's inventory, analytics and resale rule reflect the real sale and entry (XRPL-021, 037, 076)", async () => {
    const inventory = await getEventInventory(db, eventId);
    expect(inventory.totals).toEqual({ total: 2, minted: 1, minting: 0, onSale: 0, sold: 1, unsold: 1 });
    expect(inventory).toMatchObject({ primarySoldOut: false, checkedIn: 1 });

    const metrics = await getEventMetrics(db, eventId);
    expect(metrics).toMatchObject({
      ticketsTotal: 2,
      primarySold: 1,
      primaryRevenueDrops: "1000000",
      resales: 0,
      privateTransfers: 1,
      gifts: 1,
      checkedIn: 1,
      notCheckedIn: 0,
      pending: { purchases: 0, listings: 0, mints: 0 },
    });
    expect(metrics.checkInTimeline.reduce((n, bucket) => n + bucket.count, 0)).toBe(1);

    // One of the two tickets is still unsold, so resale stays closed in the app.
    const resale = new ResalePolicy({
      events: prismaPolicyEvents(db),
      inventory: createInventoryPort(db),
      offers: new PrismaResaleOffers(db),
    });
    expect(await resale.getEligibility(eventId)).toMatchObject({
      isPublicResaleAllowed: false,
      reasonCode: "PRIMARY_STILL_ON_SALE",
    });
  });

  it("only someone who was checked in can review the event (XRPL-079)", async () => {
    // The buyer's wallet as a proven link (wallet sign-in, XRPL-012, is tested separately).
    await db.walletLink.create({
      data: { userId: buyerId, address: buyer.classicAddress, verifiedAt: new Date(), verificationProvider: "lifecycle-test" },
    });
    const reviews = new ReviewService({ attendance: new PrismaAttendance(db), store: new PrismaReviewStore(db) });

    expect(await reviews.create(buyerId, eventId, { rating: 5, body: "Checked in on Testnet" })).toMatchObject({
      rating: 5,
      author: { id: buyerId },
    });
    await expect(reviews.create(sellerId, eventId, { rating: 5, body: "" })).rejects.toMatchObject({ code: "NOT_ATTENDED" });
    expect(await reviews.list(eventId, null)).toMatchObject({ count: 1, averageRating: 5 });
  });
});
