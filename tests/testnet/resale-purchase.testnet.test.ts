import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createXrplQueryService } from "@/lib/xrpl";
import { requestHolderOffer, type HolderOfferDeps } from "@/lib/xrpl/offers/holder";
import { reconcilePrimaryOffer, requestPrimaryOffer } from "@/lib/xrpl/offers/primary";
import { getOfferStatus, requestPurchase, type PurchaseDeps } from "@/lib/xrpl/offers/purchase";
import { reconcileTicketMint, requestTicketMint, type MintDeps } from "@/lib/xrpl/tickets/minting";
import { listTicketsForOwner } from "@/lib/xrpl/tickets/ownership";
import { createWalletSignRequests } from "@/lib/xrpl/wallet/sign-requests";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { CheckInService } from "@/features/checkin/checkin-service";
import { EventSellerAccess } from "@/features/checkin/organiser-access";
import { PrismaCheckInStore, PrismaTicketDirectory } from "@/features/checkin/prisma-store";
import { XamanCheckInProofs } from "@/features/checkin/xaman-proof";
import { XrplLedgerOwnership } from "@/features/checkin/xrpl-ownership";
import { getEventMetrics } from "@/features/organiser/metrics";
import { getOfferPage } from "@/features/transfers/server";
import { createInventoryPort } from "@/lib/inventory/primary-inventory";
import { PrismaResaleOffers, prismaPolicyEvents } from "@/lib/resale-policy/prisma-adapters";
import { ResalePolicy } from "@/lib/resale-policy/resale-policy";
import { setResalePolicyForTests } from "@/lib/resale-policy/server";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * XRPL-039: buying a resale ticket on live XRPL Testnet, and with it the whole demo story (XRPL-052):
 * a seller mints and sells a ticket, the buyer resells it once the event has sold out, another fan
 * buys it in their own wallet, and that fan gets in at the door, once.
 *
 * Run on demand with `npm run test:testnet` (needs the internet and `npm run db:up`; never part of
 * CI). What is real and what is stood in for is in tests/testnet/README.md: the app's services, the
 * database, the ledger and the faucet are real; a throwaway wallet approves in Xaman's place.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);
const PRIMARY_PRICE = "1000000";
const RESALE_PRICE = "1500000";

let seller: TestWallet;
let buyer: TestWallet;
let fan: TestWallet;
let xaman: AutoApproveXaman;
let deps: MintDeps;
let offerDeps: HolderOfferDeps;
let purchaseDeps: PurchaseDeps;
/** The purchase service with no resale rule wired in. */
let purchaseDepsWithoutRule: PurchaseDeps;
let policy: ResalePolicy;
let sellerId: string;
let buyerId: string;
let fanId: string;
let eventId: string;
let tierId: string;

const session = (
  userId: string,
  wallet: TestWallet,
  role: AuthSession["role"] = "CUSTOMER",
): AuthSession => ({
  sessionId: `resale-test-${userId}`,
  userId,
  displayName: "Resale test user",
  role,
  onboardedAt: new Date(),
  isDemo: false,
  method: "ONBOARDING",
  expiresAt: new Date(Date.now() + 60 * 60_000),
  // Wallet control is taken as proven here; the sign-in proof (XRPL-012) has its own tests.
  walletAddress: wallet.classicAddress,
  walletVerifiedAt: new Date(),
});

const balanceOf = async (wallet: TestWallet) =>
  BigInt((await ledger.getAccountInfo(wallet.classicAddress)).balanceDrops as string);

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  fan = await fundTestWallet(connection, config);
  xaman = new AutoApproveXaman(connection, config.network, [seller, buyer, fan]);

  // The in-app resale rule (XRPL-037), with the app's own adapters over this database.
  policy = new ResalePolicy({
    events: prismaPolicyEvents(db),
    inventory: createInventoryPort(db),
    offers: new PrismaResaleOffers(db),
  });
  setResalePolicyForTests(policy);

  deps = {
    db,
    transactions: () => createWalletTransactionRequests(config, xaman, ledger),
    ledger: () => ledger,
    config,
    baseUrl: "http://localhost:3000",
  };
  offerDeps = { db, transactions: deps.transactions, ledger: () => ledger, config };
  purchaseDepsWithoutRule = { db, transactions: deps.transactions, ledger: () => ledger, config };
  purchaseDeps = { ...purchaseDepsWithoutRule, resalePolicy: () => policy };

  const user = await db.user.create({
    data: { displayName: "Resale test seller", role: "SELLER", onboardedAt: new Date() },
  });
  const event = await db.event.create({
    data: {
      sellerId: user.id,
      title: "Resale test event",
      startsAt: new Date("2027-06-01T20:00:00.000Z"),
      venue: "Test venue",
      city: "Dublin",
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
  // One ticket only, so its primary sale sells the event out and opens resale.
  const tier = await db.ticketTier.create({
    data: { eventId: event.id, name: "General Admission", priceDrops: PRIMARY_PRICE, totalSupply: 1 },
  });
  const customer = (displayName: string) =>
    db.user.create({ data: { displayName, role: "CUSTOMER", onboardedAt: new Date() } });
  sellerId = user.id;
  buyerId = (await customer("Resale test buyer")).id;
  fanId = (await customer("Resale test fan")).id;
  eventId = event.id;
  tierId = tier.id;
});

afterAll(async () => {
  setResalePolicyForTests(null);
  await ledger.close();
  await connection.disconnect();
  await db.$disconnect();
});

describe("resale purchase on XRPL Testnet (XRPL-039)", () => {
  let ticketId: string;
  let nftokenId: string;
  let resaleOfferId: string;
  let resaleIndex: string;

  const offerSettled = (offerId: string, what: string) =>
    waitFor(
      () => getOfferStatus(purchaseDeps, offerId),
      (s) => s.offer.state !== "PENDING_SIGNATURE" && !s.purchasePending,
      { what },
    );

  it("the seller mints the event's only ticket and a buyer buys it, which sells the event out", async () => {
    const { ticket } = await requestTicketMint(deps, {
      session: session(sellerId, seller, "SELLER"),
      eventId,
      tierId,
    });
    ticketId = ticket.id;
    const minted = await waitFor(
      () => reconcileTicketMint(deps, ticketId),
      (t) => t.mintStatus === "MINTED" || t.mintStatus === "FAILED",
      { what: "the mint to reach a validated ledger" },
    );
    expect(minted.mintStatus).toBe("MINTED");
    nftokenId = minted.nftokenId as string;

    const { offer } = await requestPrimaryOffer(offerDeps, {
      session: session(sellerId, seller, "SELLER"),
      ticketId,
    });
    const listed = await waitFor(
      () => reconcilePrimaryOffer(offerDeps, offer.id),
      (o) => o.state !== "PENDING_SIGNATURE",
      { what: "the primary offer to reach a validated ledger" },
    );
    expect(listed.state).toBe("ACTIVE");

    // Until the primary sale, the app's resale rule keeps resale closed.
    expect(await policy.getEligibility(eventId)).toMatchObject({
      isPublicResaleAllowed: false,
      reasonCode: "PRIMARY_STILL_ON_SALE",
    });

    await requestPurchase(purchaseDeps, { session: session(buyerId, buyer), offerId: offer.id });
    expect(
      (await offerSettled(offer.id, "the primary purchase to reach a validated ledger")).offer.state,
    ).toBe("ACCEPTED");
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
    expect(await policy.getEligibility(eventId)).toMatchObject({ isPublicResaleAllowed: true });
  });

  it("the holder lists the ticket for resale, and the app shows it for sale to another fan", async () => {
    const listing = await requestHolderOffer(offerDeps, {
      session: session(buyerId, buyer),
      ticketId,
      offer: { kind: "RESALE", amountDrops: RESALE_PRICE },
    });
    resaleOfferId = listing.offer.id;
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      TransactionType: "NFTokenCreateOffer",
      Account: buyer.classicAddress,
      NFTokenID: nftokenId,
      Amount: RESALE_PRICE,
    });
    const listed = await offerSettled(resaleOfferId, "the resale listing to reach a validated ledger");
    expect(listed.offer).toMatchObject({ state: "ACTIVE", kind: "RESALE", amountDrops: RESALE_PRICE });
    resaleIndex = listed.offer.offerIndex as string;

    // The ledger holds the open sell offer, with no named buyer.
    expect((await ledger.getOffers(nftokenId)).sellOffers).toContainEqual(
      expect.objectContaining({
        offerIndex: resaleIndex,
        owner: buyer.classicAddress,
        amountDrops: RESALE_PRICE,
        destination: null,
      }),
    );

    // The event is sold out, so the in-app rule lists it publicly, and the offer page offers the buy
    // action to another fan only after re-checking that rule and the ledger.
    const { offers } = await policy.listPublicOffers(eventId);
    expect(offers.map((o) => o.offerId)).toEqual([resaleOfferId]);
    expect(await getOfferPage(deps, resaleOfferId, fan.classicAddress)).toMatchObject({
      status: "OPEN",
      offer: { kind: "RESALE", amountDrops: RESALE_PRICE, sellerAddress: buyer.classicAddress },
    });
  });

  it("refuses to sell it where the rule can't be checked, and to its own holder", async () => {
    // Without the resale rule the purchase fails closed, as if there were no such offer.
    await expect(
      requestPurchase(purchaseDepsWithoutRule, { session: session(fanId, fan), offerId: resaleOfferId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      requestPurchase(purchaseDeps, { session: session(buyerId, buyer), offerId: resaleOfferId }),
    ).rejects.toMatchObject({ status: 409 });
    // Nothing was asked of a wallet, and the offer is untouched.
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({ TransactionType: "NFTokenCreateOffer" });
    expect((await getOfferStatus(purchaseDeps, resaleOfferId)).offer.state).toBe("ACTIVE");
  });

  it("another fan buys it in their own wallet: the ledger moves the NFT and pays the holder", async () => {
    const [holderBefore, fanBefore] = await Promise.all([balanceOf(buyer), balanceOf(fan)]);

    const { request } = await requestPurchase(purchaseDeps, {
      session: session(fanId, fan),
      offerId: resaleOfferId,
    });
    expect(request.purpose).toBe("ACCEPT_TRANSFER_OFFER");
    expect(xaman.approved.at(-1)?.txjson).toMatchObject({
      TransactionType: "NFTokenAcceptOffer",
      Account: fan.classicAddress,
      NFTokenSellOffer: resaleIndex,
    });
    const acceptHash = xaman.approved.at(-1)?.hash as string;

    const settled = await waitFor(
      () => getOfferStatus(purchaseDeps, resaleOfferId),
      (s) => !s.purchasePending && s.offer.state !== "ACTIVE",
      { what: "the resale purchase to reach a validated ledger" },
    );
    expect(settled.offer).toMatchObject({ state: "ACCEPTED", acceptTxHash: acceptHash });

    // The ledger itself confirms the trade: validated, successful, signed by the fan, for this NFT.
    expect(await ledger.getValidatedTx(acceptHash)).toMatchObject({
      validated: true,
      result: "tesSUCCESS",
      transactionType: "NFTokenAcceptOffer",
      account: fan.classicAddress,
      nftokenId,
    });
    // Ownership changed on the ledger, and the sell offer is gone.
    expect((await ledger.verifyOwner(nftokenId, fan.classicAddress)).owns).toBe(true);
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(false);
    expect((await ledger.getOffers(nftokenId)).sellOffers.map((o) => o.offerIndex)).not.toContain(
      resaleIndex,
    );

    // The holder was paid the resale price in full; the fan paid it plus the network fee.
    const [holderAfter, fanAfter] = await Promise.all([balanceOf(buyer), balanceOf(fan)]);
    expect(holderAfter - holderBefore).toBe(BigInt(RESALE_PRICE));
    const paid = fanBefore - fanAfter;
    expect(paid).toBeGreaterThan(BigInt(RESALE_PRICE));
    expect(paid).toBeLessThan(BigInt(RESALE_PRICE) + BigInt(1000));
  });

  it("both collections and the resale listing reflect the trade", async () => {
    const ownership = { db, ledger: () => ledger, config };
    // My tickets is read from each wallet's NFTs on a validated ledger.
    const fanTickets = await listTicketsForOwner(ownership, { address: fan.classicAddress });
    expect(fanTickets.map((t) => t.id)).toEqual([ticketId]);
    expect(fanTickets[0]?.ledger).toMatchObject({ nftokenId, ownerAddress: fan.classicAddress });
    expect(await listTicketsForOwner(ownership, { address: buyer.classicAddress })).toEqual([]);

    // The app's records agree: new owner, offer accepted by the fan, primary sale untouched.
    const ticket = await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } });
    expect(ticket.cachedOwnerAddress).toBe(fan.classicAddress);
    expect(ticket.primarySoldAt).not.toBeNull();
    const offer = await db.nFTOffer.findUniqueOrThrow({ where: { id: resaleOfferId } });
    expect(offer).toMatchObject({ state: "ACCEPTED", acceptedByAddress: fan.classicAddress });

    // It's no longer for sale anywhere in the app, and the organiser sees one resale.
    expect((await policy.listPublicOffers(eventId)).offers).toEqual([]);
    expect(await getOfferPage(deps, resaleOfferId, fan.classicAddress)).toMatchObject({ status: "CLOSED" });
    expect(await getEventMetrics(db, eventId)).toMatchObject({
      primarySold: 1,
      primaryRevenueDrops: PRIMARY_PRICE,
      resales: 1,
    });
  });

  it("the new owner gets in once at the door; the previous holder and a second scan are refused", async () => {
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

    // The buyer sold the ticket on, so the ledger says their wallet can't get a door code for it.
    expect(await checkIn.issueChallenge({ ticketId, walletAddress: buyer.classicAddress })).toMatchObject({
      status: "WRONG_OWNER",
    });

    const code = await checkIn.issueChallenge({ ticketId, walletAddress: fan.classicAddress });
    if (!("challengeId" in code)) throw new Error(`Expected a check-in code, got ${code.status}`);
    xaman.signInWith(fan);
    const signIn = await signIns.createSignIn();
    expect(
      await checkIn.proveControl({
        challengeId: code.challengeId,
        proof: proofs.tokenFor(code.challengeId, signIn.id),
      }),
    ).toEqual({ status: "PROVEN", challengeId: code.challengeId });

    expect(await checkIn.admit(gate(code.qrPayload))).toMatchObject({
      status: "ADMITTED",
      ticketId,
      eventId,
    });
    expect(await checkIn.admit(gate(code.qrPayload))).toMatchObject({ status: "ALREADY_USED" });
    const records = await db.checkInRecord.findMany({ where: { ticketId } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ walletAddress: fan.classicAddress, organiserId: sellerId });

    // A used ticket can't be offered on again.
    await expect(
      requestHolderOffer(offerDeps, {
        session: session(fanId, fan),
        ticketId,
        offer: { kind: "RESALE", amountDrops: RESALE_PRICE },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
