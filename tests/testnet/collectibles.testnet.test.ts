import { parseNFTokenID } from "xrpl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSalesOnLedger, getStorefrontMetrics } from "@/features/analytics/storefront-metrics";
import { uploadMediaAsset } from "@/features/collectibles/assets";
import {
  getTokenStatus,
  listOwnedCollectibles,
  reconcileToken,
  requestCollectibleMint,
  requestCollectiblePurchase,
  requestCollectibleSale,
  type CollectibleDeps,
} from "@/features/collectibles/ledger";
import { createCollectible, updateCollectible } from "@/features/collectibles/listings";
import { COLLECTIBLE_TAXON } from "@/features/collectibles/metadata";
import type { MediaStorage } from "@/features/collectibles/storage";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { createXrplQueryService } from "@/lib/xrpl";
import { createWalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";
import { AutoApproveXaman } from "./support/auto-approve-xaman";
import { fundTestWallet, openTestnet, type TestWallet } from "./support/testnet";
import { waitFor } from "./support/wait";

/**
 * Digital collectibles on live XRPL Testnet (XRPL-073 to XRPL-075): a seller mints one edition, lists
 * it for sale, and another wallet buys it. Run on demand with `npm run test:testnet` (see README.md).
 *
 * Everything is the app's real code against the real ledger. Only the person approving in Xaman is
 * simulated (AutoApproveXaman), and the media file is kept in memory instead of on disk.
 */

const db = getDb();
const { config, connection } = openTestnet();
const ledger = createXrplQueryService(config);

const PRICE_DROPS = "2000000";
const BASE_URL = "http://localhost:3000";
/** The smallest file the upload check accepts as a PNG (it reads the file's signature). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

let seller: TestWallet;
let buyer: TestWallet;
let deps: CollectibleDeps;
let sellerId: string;
let buyerId: string;
let collectibleId: string;

function memoryStorage(): MediaStorage {
  const files = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => void files.set(key, bytes),
    size: async (key) => files.get(key)?.length ?? null,
    read: async (key) => files.get(key) ?? new Uint8Array(),
    delete: async (key) => void files.delete(key),
  };
}

/** A signed-in account whose wallet control is already proven (XRPL-012 is tested separately). */
function sessionFor(userId: string, role: AuthSession["role"], wallet: TestWallet): AuthSession {
  return {
    sessionId: `collectibles-test-${role}`,
    userId,
    displayName: role === "SELLER" ? "Collectibles test artist" : "Collectibles test fan",
    role,
    onboardedAt: new Date(),
    isDemo: false,
    method: "ONBOARDING",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    walletAddress: wallet.classicAddress,
    walletVerifiedAt: new Date(),
  };
}
const sellerSession = () => sessionFor(sellerId, "SELLER", seller);
const buyerSession = () => sessionFor(buyerId, "CUSTOMER", buyer);

beforeAll(async () => {
  await db.$executeRawUnsafe(
    `TRUNCATE "CollectibleToken","Collectible","MediaAsset","Session","CheckInRecord","CheckInChallenge","NFTOffer","LedgerTransaction","TicketNFT","TicketTier","Event","WalletLink","IdempotencyRecord","User" CASCADE`,
  );

  seller = await fundTestWallet(connection, config);
  buyer = await fundTestWallet(connection, config);
  const xaman = new AutoApproveXaman(connection, config.network, [seller, buyer]);
  deps = {
    db,
    transactions: () => createWalletTransactionRequests(config, xaman, ledger),
    ledger: () => ledger,
    config,
    baseUrl: BASE_URL,
  };

  const artist = await db.user.create({
    data: { displayName: "Collectibles test artist", role: "SELLER", onboardedAt: new Date() },
  });
  const fan = await db.user.create({
    data: { displayName: "Collectibles test fan", role: "CUSTOMER", onboardedAt: new Date() },
  });
  sellerId = artist.id;
  buyerId = fan.id;

  // Upload with the rights declaration, create a one-edition draft and publish it (XRPL-070 to XRPL-072).
  const asset = await uploadMediaAsset(
    { db, storage: memoryStorage() },
    { session: sellerSession(), fileName: "tour-poster.png", bytes: PNG, rightsConfirmed: true },
  );
  const draft = await createCollectible(db, sellerSession(), {
    mediaAssetId: asset.id,
    title: "Testnet tour poster",
    description: "Live Testnet check of a digital collectible.",
    editionSize: 1,
    priceDrops: PRICE_DROPS,
  });
  const published = await updateCollectible({ db, baseUrl: BASE_URL }, sellerSession(), draft.id, {
    status: "PUBLISHED",
  });
  collectibleId = published.id;
});

afterAll(async () => {
  await ledger.close();
  await connection.disconnect();
  await db.$disconnect();
});

const settled = (tokenId: string) => reconcileToken(deps, tokenId);

describe("digital collectibles on XRPL Testnet (XRPL-073 to XRPL-075)", () => {
  let tokenId: string;
  let nftokenId: string;
  let offerIndex: string;

  it("mints the edition as an NFT, recorded only from the validated ledger result", async () => {
    const { token, request } = await requestCollectibleMint(deps, { session: sellerSession(), collectibleId });
    tokenId = token.id;
    expect(request.transactionType).toBe("NFTokenMint");
    // Nothing is minted in the app's records until the ledger says so.
    expect(token).toMatchObject({ mintStatus: "PENDING", nftokenId: null });

    const minted = await waitFor(
      () => settled(tokenId),
      (t) => t.mintStatus === "MINTED" || t.mintStatus === "FAILED",
      { what: "the collectible mint to reach a validated ledger" },
    );
    expect(minted.mintStatus).toBe("MINTED");
    nftokenId = minted.nftokenId as string;
    expect(minted).toMatchObject({ issuerAddress: seller.classicAddress, ownerAddress: seller.classicAddress });

    const tx = await ledger.getValidatedTx(minted.mintTxHash as string);
    expect(tx).toMatchObject({
      validated: true,
      result: "tesSUCCESS",
      transactionType: "NFTokenMint",
      account: seller.classicAddress,
      nftokenId,
    });
    console.info(`[evidence] collectible mint ${tx.hash} NFT ${nftokenId}`);

    // Running it again changes nothing, and the one edition can't be minted twice.
    expect((await settled(tokenId)).nftokenId).toBe(nftokenId);
    await expect(requestCollectibleMint(deps, { session: sellerSession(), collectibleId })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("is a collectible on the ledger, not a ticket: its own taxon, the seller holds it, and no ticket record exists", async () => {
    const parsed = parseNFTokenID(nftokenId);
    expect(parsed.Taxon).toBe(COLLECTIBLE_TAXON);
    expect(parsed.Issuer).toBe(seller.classicAddress);
    expect(parsed.TransferFee).toBe(0);

    const token = await db.collectibleToken.findUniqueOrThrow({ where: { id: tokenId } });
    const holding = await ledger.verifyOwner(nftokenId, seller.classicAddress);
    expect(holding.owns).toBe(true);
    expect(holding.nft?.uri).toBe(token.metadataUri);
    expect(token.metadataUri).toBe(`${BASE_URL}/api/collectibles/tokens/${tokenId}/metadata`);

    // Collectibles never reach the ticket tables, so they can't appear in ticket lists or at the door.
    expect(await db.ticketNFT.count()).toBe(0);
    expect(await db.nFTOffer.count()).toBe(0);
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("lists the edition for sale with a real sell offer at the collectible's price", async () => {
    // Before the listing exists a buyer is refused.
    await expect(requestCollectiblePurchase(deps, { session: buyerSession(), tokenId })).rejects.toMatchObject({
      status: 409,
    });

    const { request, amountDrops } = await requestCollectibleSale(deps, { session: sellerSession(), tokenId });
    expect(request.transactionType).toBe("NFTokenCreateOffer");
    expect(amountDrops).toBe(PRICE_DROPS);

    const listed = await waitFor(
      () => settled(tokenId),
      (t) => t.offerStatus !== "PENDING",
      { what: "the collectible sell offer to reach a validated ledger" },
    );
    expect(listed).toMatchObject({ offerStatus: "ACTIVE", offerAmountDrops: PRICE_DROPS, saleStatus: "NONE" });
    offerIndex = listed.offerIndex as string;

    const live = await ledger.getOffers(nftokenId);
    expect(live.sellOffers).toHaveLength(1);
    expect(live.sellOffers[0]).toMatchObject({
      offerIndex,
      owner: seller.classicAddress,
      amountDrops: PRICE_DROPS,
      destination: null,
    });
    console.info(`[evidence] collectible sell offer ${listed.offerTxHash} offer ${offerIndex}`);

    expect((await getTokenStatus(deps, tokenId)).forSale).toBe(true);
    // The seller can't buy their own edition, and can't list it twice.
    await expect(requestCollectiblePurchase(deps, { session: sellerSession(), tokenId })).rejects.toMatchObject({
      status: 409,
    });
    await expect(requestCollectibleSale(deps, { session: sellerSession(), tokenId })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("sells it to another wallet, recorded only from the validated purchase", async () => {
    const { request, amountDrops } = await requestCollectiblePurchase(deps, { session: buyerSession(), tokenId });
    expect(request.transactionType).toBe("NFTokenAcceptOffer");
    expect(amountDrops).toBe(PRICE_DROPS);

    const sold = await waitFor(
      () => settled(tokenId),
      (t) => t.saleStatus !== "PENDING",
      { what: "the collectible purchase to reach a validated ledger" },
    );
    expect(sold).toMatchObject({
      saleStatus: "SOLD",
      offerStatus: "ACCEPTED",
      ownerAddress: buyer.classicAddress,
    });

    const tx = await ledger.getValidatedTx(sold.saleTxHash as string);
    expect(tx).toMatchObject({
      validated: true,
      result: "tesSUCCESS",
      transactionType: "NFTokenAcceptOffer",
      account: buyer.classicAddress,
      nftokenId,
    });
    console.info(`[evidence] collectible purchase ${tx.hash}`);

    // The ledger agrees: the buyer holds the NFT, the seller doesn't, and the offer is gone.
    expect((await ledger.verifyOwner(nftokenId, buyer.classicAddress)).owns).toBe(true);
    expect((await ledger.verifyOwner(nftokenId, seller.classicAddress)).owns).toBe(false);
    expect((await ledger.getOffers(nftokenId)).sellOffers).toHaveLength(0);

    // Sold once: nobody can buy it again, and the seller can't relist an NFT they no longer hold.
    await expect(requestCollectiblePurchase(deps, { session: buyerSession(), tokenId })).rejects.toMatchObject({
      status: 409,
    });
    await expect(requestCollectibleSale(deps, { session: sellerSession(), tokenId })).rejects.toMatchObject({
      status: 409,
    });
    expect((await getTokenStatus(deps, tokenId)).forSale).toBe(false);
  });

  it("shows the collectible in the buyer's collection, checked on the ledger, and not in the seller's", async () => {
    const owned = await listOwnedCollectibles(deps, { address: buyer.classicAddress });
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      ownerAddress: buyer.classicAddress,
      token: { id: tokenId, nftokenId, edition: 1, editionSize: 1, saleStatus: "SOLD" },
      collectible: { id: collectibleId, title: "Testnet tour poster" },
    });
    expect(owned[0]?.verifiedLedgerIndex).toEqual(expect.any(Number));

    expect(await listOwnedCollectibles(deps, { address: seller.classicAddress })).toEqual([]);
    // Still no ticket records: the collection is collectibles only.
    expect(await db.ticketNFT.count()).toBe(0);
  });

  it("reports the sale in the seller's analytics, and the ledger confirms the transaction behind it (XRPL-078)", async () => {
    const metrics = await getStorefrontMetrics(db, sellerId, config);
    expect(metrics.collectibles).toMatchObject({
      currency: "XRP",
      settlement: "XRPL",
      listings: 1,
      editions: 1,
      minted: 1,
      forSale: 0,
      sold: 1,
      revenueDrops: PRICE_DROPS,
      pending: { mints: 0, listings: 0, purchases: 0 },
      reconciliation: { salesWithTransaction: 1, salesWithTransactionDrops: PRICE_DROPS, reconciled: true },
    });
    // A collectible sale is not a ticket sale or a merchandise order.
    expect(metrics.tickets).toMatchObject({ sold: 0, revenueDrops: "0" });
    expect(metrics.merchandise).toMatchObject({ orders: 0, orderValueDrops: "0" });

    const [sale] = metrics.collectibles.sales;
    expect(sale).toMatchObject({ tokenId, nftokenId, amountDrops: PRICE_DROPS });
    // The recorded sale is read again from the ledger: validated, successful, and it moved this NFT.
    const checks = await checkSalesOnLedger(ledger, metrics.collectibles.sales);
    expect(checks).toEqual([{ txHash: sale?.txHash, outcome: "VALIDATED", ledgerIndex: expect.any(Number) }]);
  });
});
