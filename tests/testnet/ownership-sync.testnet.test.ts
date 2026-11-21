import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SubmittableTransaction } from "xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getTicketHistory } from "@/lib/ownership/history";
import { reconcileTicket } from "@/lib/ownership/ticket-sync";
import { reconcileLedgerTransaction } from "@/lib/ownership/transfers";
import { createXrplQueryService } from "@/lib/xrpl";
import { requestHolderOffer } from "@/lib/xrpl/offers/holder";
import { reconcilePrimaryOffer, requestPrimaryOffer } from "@/lib/xrpl/offers/primary";
import { getOfferStatus, requestPurchase } from "@/lib/xrpl/offers/purchase";
import { reconcileTicketMint, requestTicketMint } from "@/lib/xrpl/tickets/minting";
import type { TicketingDeps } from "@/lib/xrpl/tickets/server";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * XRPL-043 on live XRPL Testnet: keeping a ticket's ownership in step with the ledger after it changes
 * hands, in the app and outside it. Run on demand with `npm run test:testnet` (see README.md).
 *
 * The app's own steps (mint, listing, purchase, gift offer, resale listing) are approved by
 * AutoApproveXaman, as in the lifecycle suite. "Outside the app" means a wallet signing and submitting
 * straight to the ledger with xrpl.js: the app never sees those transactions, only their results.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);

let seller: TestWallet;
let buyer: TestWallet;
let friend: TestWallet;
let other: TestWallet;
let deps: TicketingDeps;
const users: Record<"seller" | "buyer" | "friend", string> = { seller: "", buyer: "", friend: "" };
let eventId: string;
let tierId: string;

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  friend = await fundTestWallet(connection, config);
  other = await fundTestWallet(connection, config);
  // `other` never uses the app, so it never approves anything through "Xaman".
  const xaman = new AutoApproveXaman(connection, config.network, [seller, buyer, friend]);
  deps = {
    db,
    transactions: () => createWalletTransactionRequests(config, xaman, ledger),
    ledger: () => ledger,
    config,
    baseUrl: "http://localhost:3000",
  };

  for (const name of ["seller", "buyer", "friend"] as const) {
    users[name] = (
      await db.user.create({
        data: { displayName: `Ownership test ${name}`, role: name === "seller" ? "SELLER" : "CUSTOMER", onboardedAt: new Date() },
      })
    ).id;
  }
  const event = await db.event.create({
    data: {
      sellerId: users.seller,
      title: "Ownership sync test event",
      startsAt: new Date("2027-06-01T20:00:00.000Z"),
      venue: "Test venue",
      city: "Dublin",
      status: "PUBLISHED",
      publishedAt: new Date(),
    },
  });
  eventId = event.id;
  tierId = (
    await db.ticketTier.create({
      data: { eventId, name: "General Admission", priceDrops: "1000000", totalSupply: 1 },
    })
  ).id;
});

afterAll(async () => {
  await ledger.close();
  await connection.disconnect();
  await db.$disconnect();
});

/** A signed-in user whose wallet control is already proven (XRPL-012 is tested separately). */
function session(name: "seller" | "buyer" | "friend", wallet: TestWallet): AuthSession {
  return {
    sessionId: `ownership-test-${name}`,
    userId: users[name],
    displayName: `Ownership test ${name}`,
    role: name === "seller" ? "SELLER" : "CUSTOMER",
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    walletAddress: wallet.classicAddress,
    walletVerifiedAt: new Date(),
  };
}

/** Signs and submits straight to the ledger, outside the app. Returns the validated tx hash. */
async function outsideTheApp(wallet: TestWallet, tx: SubmittableTransaction): Promise<string> {
  const { result } = await connection.withClient(
    ({ client }) => client.submitAndWait(tx, { autofill: true, wallet }),
    "outside-the-app transaction",
  );
  await ledger.getValidatedTx(result.hash); // throws unless validated with tesSUCCESS
  return result.hash;
}

const settled = (offerId: string, what: string) =>
  waitFor(
    () => getOfferStatus(deps, offerId),
    (s) => s.offer.state !== "PENDING_SIGNATURE" && !s.purchasePending,
    { what },
  );

describe("ownership in step with the ledger after moves outside the app (XRPL-043)", () => {
  let ticketId: string;
  let nftokenId: string;

  it("records a gift its recipient accepted from their own wallet, and the giver can't offer it again", async () => {
    // Set-up through the app: mint, list and buy the event's only ticket.
    const { ticket } = await requestTicketMint(deps, { session: session("seller", seller), eventId, tierId });
    ticketId = ticket.id;
    const minted = await waitFor(
      () => reconcileTicketMint(deps, ticketId),
      (t) => t.mintStatus === "MINTED" || t.mintStatus === "FAILED",
      { what: "the mint to reach a validated ledger" },
    );
    expect(minted.mintStatus).toBe("MINTED");
    nftokenId = minted.nftokenId as string;
    const { offer: primary } = await requestPrimaryOffer(deps, { session: session("seller", seller), ticketId });
    await waitFor(
      () => reconcilePrimaryOffer(deps, primary.id),
      (o) => o.state !== "PENDING_SIGNATURE",
      { what: "the listing to reach a validated ledger" },
    );
    await requestPurchase(deps, { session: session("buyer", buyer), offerId: primary.id });
    expect((await settled(primary.id, "the purchase to reach a validated ledger")).offer.state).toBe("ACCEPTED");

    // The buyer offers it to the friend as a gift through the app...
    const gift = await requestHolderOffer(deps, {
      session: session("buyer", buyer),
      ticketId,
      offer: { kind: "GIFT", destination: friend.classicAddress },
    });
    const listed = await settled(gift.offer.id, "the gift offer to reach a validated ledger");
    expect(listed.offer.state).toBe("ACTIVE");

    // ...and the friend accepts it from their own wallet, outside the app.
    const accepted = await outsideTheApp(friend, {
      TransactionType: "NFTokenAcceptOffer",
      Account: friend.classicAddress,
      NFTokenSellOffer: listed.offer.offerIndex as string,
    });
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: gift.offer.id } })).toMatchObject({ state: "ACTIVE" });

    // The hash is all the app needs.
    expect(await reconcileLedgerTransaction(deps, accepted)).toEqual({
      outcome: "APPLIED",
      kind: "GIFT",
      offerId: gift.offer.id,
      ticketId,
      acceptedByAddress: friend.classicAddress,
    });
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: gift.offer.id } })).toMatchObject({
      state: "ACCEPTED",
      acceptTxHash: accepted,
    });
    expect(await db.ticketNFT.findUniqueOrThrow({ where: { id: ticketId } })).toMatchObject({
      cachedOwnerAddress: friend.classicAddress,
      ownerSyncStatus: "SYNCED",
    });

    // The buyer gave it away, so the ledger no longer lets them act on it, and neither does the app.
    await expect(
      requestHolderOffer(deps, {
        session: session("buyer", buyer),
        ticketId,
        offer: { kind: "RESALE", amountDrops: "1000000" },
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/doesn't hold this ticket/) });
  });

  it("after the holder passes it on outside the app, reconciling closes their listing and finds the new owner", async () => {
    // The friend lists it for resale through the app...
    const listing = await requestHolderOffer(deps, {
      session: session("friend", friend),
      ticketId,
      offer: { kind: "RESALE", amountDrops: "2000000" },
    });
    expect((await settled(listing.offer.id, "the resale listing to reach a validated ledger")).offer.state).toBe("ACTIVE");

    // ...then hands it to another wallet entirely outside the app.
    const created = await outsideTheApp(friend, {
      TransactionType: "NFTokenCreateOffer",
      Account: friend.classicAddress,
      NFTokenID: nftokenId,
      Amount: "0",
      Flags: 1, // tfSellNFToken
      Destination: other.classicAddress,
    });
    const handOver = (await ledger.getValidatedTx(created)).offerIndex as string;
    const taken = await outsideTheApp(other, {
      TransactionType: "NFTokenAcceptOffer",
      Account: other.classicAddress,
      NFTokenSellOffer: handOver,
    });
    // That offer was never the app's, so reporting its hash records nothing.
    expect(await reconcileLedgerTransaction(deps, taken)).toEqual({ outcome: "NOT_APPLICABLE", reason: "UNKNOWN_OFFER" });
    // Until reconciled, the friend's listing still looks live in the app.
    expect(await db.nFTOffer.findUniqueOrThrow({ where: { id: listing.offer.id } })).toMatchObject({ state: "ACTIVE" });

    const result = await reconcileTicket(deps, { ticketId });
    expect(result.ownership).toMatchObject({
      status: "VERIFIED",
      ownerAddress: other.classicAddress,
      previousOwnerAddress: friend.classicAddress,
      changed: true,
    });
    expect(result.offers).toEqual([
      {
        offerId: listing.offer.id,
        kind: "RESALE",
        ownerAddress: friend.classicAddress,
        previousState: "ACTIVE",
        state: "STALE",
      },
    ]);
    expect((await ledger.verifyOwner(nftokenId, other.classicAddress)).owns).toBe(true);
    expect((await ledger.verifyOwner(nftokenId, friend.classicAddress)).owns).toBe(false);

    // The friend can't act on it any more.
    await expect(
      requestHolderOffer(deps, {
        session: session("friend", friend),
        ticketId,
        offer: { kind: "GIFT", destination: buyer.classicAddress },
      }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/doesn't hold this ticket/) });
  });

  it("shows the app's recorded steps, then the move outside the app, in the ticket's history", async () => {
    const { ownership } = await reconcileTicket(deps, { ticketId });
    const history = await getTicketHistory(deps, ticketId, ownership);

    expect(history.ownerVerified).toBe(true);
    expect(history.entries.map((e) => [e.kind, e.source, e.fromAddress, e.toAddress])).toEqual([
      ["MINT", "PLATFORM", null, seller.classicAddress],
      ["PRIMARY_SALE", "PLATFORM", seller.classicAddress, buyer.classicAddress],
      ["GIFT", "PLATFORM", buyer.classicAddress, friend.classicAddress],
      ["OUTSIDE_APP", "EXTERNAL", friend.classicAddress, other.classicAddress],
    ]);
    // Every recorded step is a validated transaction on the ledger; the outside move has none.
    for (const entry of history.entries) {
      if (entry.source === "PLATFORM") {
        expect((await ledger.getValidatedTx(entry.txHash as string)).ledgerIndex).toBe(entry.ledgerIndex);
      } else {
        expect(entry).toMatchObject({ txHash: null, ledgerIndex: ownership.ledgerIndex });
      }
    }
  });
});
