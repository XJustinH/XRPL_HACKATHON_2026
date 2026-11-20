import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckInService } from "@/features/checkin/checkin-service";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { PrismaCheckInStore, PrismaTicketDirectory } from "@/features/checkin/prisma-store";
import { XamanCheckInProofs } from "@/features/checkin/xaman-proof";
import { XrplLedgerOwnership } from "@/features/checkin/xrpl-ownership";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createXrplQueryService } from "@/lib/xrpl";
import { listPrimaryOffers, reconcilePrimaryOffer, requestPrimaryOffer, type OfferDeps } from "@/lib/xrpl/offers/primary";
import { getOfferStatus, requestPurchase, type PurchaseDeps } from "@/lib/xrpl/offers/purchase";
import { reconcileTicketMint, requestTicketMint, type MintDeps } from "@/lib/xrpl/tickets/minting";
import { createWalletSignRequests, type WalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * XRPL-050: the ticket lifecycle against live XRPL Testnet. Run on demand with `npm run test:testnet`
 * (needs the internet and `npm run db:up`; never part of CI). See tests/testnet/README.md.
 *
 * Real: the app's services, the *_test database, XRPL Testnet and its faucet.
 * Stood in for: the person approving in Xaman (AutoApproveXaman signs with a throwaway wallet), and
 * the wallet sign-in proof (XRPL-012, covered by its own tests): the seller's session starts with
 * the throwaway wallet as its proven wallet.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);
// Test-only signing keys for check-in codes and wallet-approval tokens (32+ bytes, not real secrets).
const CHECKIN_QR_SECRET = "lifecycle-test-checkin-qr-secret-0123456789";
const CHECKIN_PROOF_SECRET = "lifecycle-test-checkin-proof-secret-0123456789";

let seller: TestWallet;
let buyer: TestWallet;
let xaman: AutoApproveXaman;
let deps: MintDeps;
let offerDeps: OfferDeps;
let purchaseDeps: PurchaseDeps;
let signRequests: WalletSignRequests;
let proofs: XamanCheckInProofs;
let checkIn: CheckInService;
let sellerId: string;
let buyerId: string;
let eventId: string;
let tierId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  xaman = new AutoApproveXaman(connection, config.network, [seller, buyer]);
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
  // The check-in service as the app wires it (src/features/checkin/server.ts), with the test double as Xaman.
  signRequests = createWalletSignRequests(config, xaman);
  proofs = new XamanCheckInProofs(() => signRequests, CHECKIN_PROOF_SECRET);
  checkIn = new CheckInService(
    {
      tickets: new PrismaTicketDirectory(db),
      organisers: new EventSellerAccess(db),
      ledger: new XrplLedgerOwnership({ verifyOwner: (nftId, address) => ledger.verifyOwner(nftId, address) }),
      proofs,
      store: new PrismaCheckInStore(db),
    },
    { qrSecret: CHECKIN_QR_SECRET },
  );

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

  it.todo("the buyer resells the ticket or sends it privately to a friend (needs XRPL-036, XRPL-039, XRPL-040)");
  it("the current holder checks in once, and every later attempt is rejected", async () => {
    // The seller no longer holds the ticket, so the ledger refuses them a check-in code.
    await expect(checkIn.issueChallenge({ ticketId, walletAddress: seller.classicAddress })).resolves.toMatchObject({
      status: "WRONG_OWNER",
    });

    // The holder (the buyer) gets a code for the ticket.
    const issued = await checkIn.issueChallenge({ ticketId, walletAddress: buyer.classicAddress });
    if ("status" in issued) throw new Error(`No check-in code: ${issued.status} ${issued.message}`);
    const { challengeId, qrPayload } = issued;

    // A sign-in by any other wallet can't approve it.
    xaman.signInAs(seller);
    const wrongSignIn = await signRequests.createSignIn();
    await expect(
      checkIn.proveControl({ challengeId, proof: proofs.tokenFor(challengeId, wrongSignIn.id) }),
    ).resolves.toMatchObject({ status: "INVALID_PROOF" });

    // The holder approves it in their wallet, proving they control the wallet that holds the NFT.
    xaman.signInAs(buyer);
    const signIn = await signRequests.createSignIn();
    await expect(
      checkIn.proveControl({ challengeId, proof: proofs.tokenFor(challengeId, signIn.id) }),
    ).resolves.toMatchObject({ status: "PROVEN" });

    // The organiser (the event's seller) scans: ownership is read from the ledger again, then admitted once.
    const scan = { qrPayload, organiserId: sellerId, gateEventId: eventId };
    await expect(checkIn.verifyScan(scan)).resolves.toMatchObject({
      status: "VERIFIED",
      ticketId,
      nftokenId,
      ownerAddress: buyer.classicAddress,
    });
    await expect(checkIn.admit(scan)).resolves.toMatchObject({ status: "ADMITTED", ticketId });

    // The same code again, or a new code for the same ticket, is refused.
    await expect(checkIn.admit(scan)).resolves.toMatchObject({ status: "ALREADY_USED" });
    await expect(checkIn.issueChallenge({ ticketId, walletAddress: buyer.classicAddress })).resolves.toMatchObject({
      status: "ALREADY_USED",
    });
    const records = await db.checkInRecord.findMany({ where: { ticketId } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ walletAddress: buyer.classicAddress, organiserId: sellerId });
  });
});
