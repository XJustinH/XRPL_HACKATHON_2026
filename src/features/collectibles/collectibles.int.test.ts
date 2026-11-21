import { randomUUID } from "node:crypto";

import { convertHexToString } from "xrpl";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfirmedLedgerTx, TransactionRequest, TransactionRequestStatus } from "@/contracts/xrpl";
import type { AuthSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { nftokenIdFor } from "@/lib/xrpl/tickets/__tests__/nft-ids";

import { findViewableAsset, sniffMediaType, uploadMediaAsset } from "./assets";
import {
  listOwnedCollectibles,
  reconcileToken,
  requestCollectibleMint,
  requestCollectiblePurchase,
  requestCollectibleSale,
  STALE_OFFER_MESSAGE,
  type CollectibleDeps,
} from "./ledger";
import { createCollectible, updateCollectible } from "./listings";
import { buildCollectibleMetadata, COLLECTIBLE_MEMO_TYPE, COLLECTIBLE_TAXON } from "./metadata";
import type { MediaStorage } from "./storage";

/**
 * Digital collectibles (XRPL-070 to XRPL-075) against Postgres (`npm run test:db`), with media
 * storage, Xaman and the ledger faked.
 */

const db = getDb();
const SELLER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const BUYER = "rLUvY8gJhuZ3jcBKycciciVTCRS6BAuT3W";
const MINT_HASH = "E3FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_HASH = "A1FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const SALE_HASH = "B2FE6EA3D48F0C2B639448020EA4F03D4F4F8FFDB243A852A0F59177921B4879";
const OFFER_INDEX = "AED08CC1F50DD5F23A1948AF86153A3F3B7593E5EC77D65A02BB1B29E05AB6AF";
const NFT_ID = nftokenIdFor(SELLER, COLLECTIBLE_TAXON);
const BASE_URL = "http://localhost:3000";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE "CollectibleToken","Collectible","MediaAsset","Session","User" CASCADE`);
});
afterAll(async () => {
  await db.$disconnect();
});

function session(userId: string, role: AuthSession["role"], walletAddress: string | null): AuthSession {
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

function memoryStorage(): MediaStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    put: async (key, bytes) => void files.set(key, bytes),
    size: async (key) => files.get(key)?.length ?? null,
    read: async (key) => files.get(key) ?? new Uint8Array(),
    delete: async (key) => void files.delete(key),
  };
}

/** The ledger and wallet as the tests want them to look right now. */
interface World {
  status: TransactionRequestStatus;
  extra?: Partial<TransactionRequest>;
  /** The validated transaction `getValidatedTx` reports. */
  tx: Partial<ConfirmedLedgerTx>;
  /** Who holds the NFT on the ledger. */
  holder: string;
  /** Is the sell offer still on the ledger? */
  offerLive: boolean;
  metadataUri: string | null;
}

function deps(world: World) {
  const created: { id: string; purpose: string; txjson: Record<string, unknown>; reference?: string | null }[] = [];
  const request = (id: string, status: TransactionRequestStatus): TransactionRequest => ({
    id,
    purpose: "MINT_COLLECTIBLE",
    reference: null,
    status,
    transactionType: "NFTokenMint",
    account: SELLER,
    instruction: "x",
    signUrl: `https://xumm.app/sign/${id}`,
    qrPngUrl: `https://xumm.app/sign/${id}_q.png`,
    expiresAt: null,
    txHash: null,
    engineResult: null,
    ledgerIndex: null,
    explorerUrl: null,
    failureReason: null,
    ...(status === "PENDING" ? {} : world.extra),
  });
  const create = vi.fn(async (input: (typeof created)[number]) => {
    const id = randomUUID();
    created.push({ ...input, id });
    return request(id, "PENDING");
  });
  const get = vi.fn(async (id: string) => request(id, world.status));
  const getValidatedTx = vi.fn(
    async (hash: string): Promise<ConfirmedLedgerTx> => ({
      hash,
      validated: true,
      result: "tesSUCCESS",
      ledgerIndex: 1234,
      closeTime: "2026-11-21T10:00:00.000Z",
      transactionType: "NFTokenMint",
      account: SELLER,
      nftokenId: null,
      offerIndex: null,
      acceptedSellOfferIndex: null,
      explorerUrl: `https://testnet.xrpl.org/transactions/${hash}`,
      ...world.tx,
    }),
  );
  const verifyOwner = vi.fn(async (nftokenId: string, address: string) => ({
    nftokenId,
    address,
    owns: address === world.holder,
    nft: address === world.holder ? ({ uri: world.metadataUri } as never) : null,
    provenance: { endpoint: "wss://node", ledgerIndex: 1235, ledgerHash: null, validated: true, fetchedAt: "" },
  }));
  const getOffers = vi.fn(async (nftokenId: string) => ({
    nftokenId,
    sellOffers: world.offerLive
      ? [
          {
            offerIndex: OFFER_INDEX,
            nftokenId,
            side: "SELL" as const,
            owner: SELLER,
            amountDrops: "5000000",
            amountIssued: null,
            destination: null,
            expiresAt: null,
            flags: 1,
          },
        ]
      : [],
    buyOffers: [],
    provenance: { endpoint: "wss://node", ledgerIndex: 1235, ledgerHash: null, validated: true, fetchedAt: "" },
  }));
  const getAccountInfo = vi.fn(async (address: string) => ({
    address,
    exists: true,
    balanceDrops: "100000000",
    sequence: 1,
    ownerCount: 0,
  }));
  const getReserves = vi.fn(async () => ({ baseDrops: "1000000", incrementDrops: "200000" }));
  const collectibleDeps: CollectibleDeps = {
    db,
    transactions: () => ({ create, get }) as never,
    ledger: () => ({ getValidatedTx, verifyOwner, getOffers, getAccountInfo, getReserves }) as never,
    config: { network: "TESTNET", explorerUrl: "https://testnet.xrpl.org", networkLabel: "XRPL Testnet" },
    baseUrl: BASE_URL,
  };
  return { collectibleDeps, created, create, get, getValidatedTx };
}

/** A seller with one published two-edition collectible. */
async function publishedCollectible() {
  const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
  const sellerSession = session(seller.id, "SELLER", SELLER);
  const asset = await uploadMediaAsset(
    { db, storage: memoryStorage() },
    { session: sellerSession, fileName: "cover.png", bytes: PNG, rightsConfirmed: true },
  );
  const draft = await createCollectible(db, sellerSession, {
    mediaAssetId: asset.id,
    title: "Tour poster",
    description: "Signed artwork",
    editionSize: 2,
    priceDrops: "5000000",
  });
  const collectible = await updateCollectible({ db, baseUrl: BASE_URL }, sellerSession, draft.id, {
    status: "PUBLISHED",
  });
  return { seller, sellerSession, asset, collectible };
}

/** Mints edition 1 through the service, with the ledger reporting a validated mint. */
async function mintedToken() {
  const base = await publishedCollectible();
  const world: World = {
    status: "CONFIRMED",
    extra: { txHash: MINT_HASH },
    tx: { nftokenId: NFT_ID },
    holder: SELLER,
    offerLive: false,
    metadataUri: base.collectible.tokens[0]?.metadataUri ?? null,
  };
  const wiring = deps(world);
  const mint = await requestCollectibleMint(wiring.collectibleDeps, {
    session: base.sellerSession,
    collectibleId: base.collectible.id,
  });
  await reconcileToken(wiring.collectibleDeps, mint.token.id);
  return { ...base, ...wiring, world, tokenId: mint.token.id };
}

/** As `mintedToken`, then lists the edition for sale with a validated sell offer. */
async function listedToken() {
  const base = await mintedToken();
  await requestCollectibleSale(base.collectibleDeps, { session: base.sellerSession, tokenId: base.tokenId });
  Object.assign(base.world, {
    extra: { txHash: OFFER_HASH },
    tx: { transactionType: "NFTokenCreateOffer", offerIndex: OFFER_INDEX },
    offerLive: true,
  });
  const token = await reconcileToken(base.collectibleDeps, base.tokenId);
  expect(token).toMatchObject({ offerStatus: "ACTIVE", offerIndex: OFFER_INDEX, offerAmountDrops: "5000000" });
  // New wallet requests start out waiting for the user.
  base.world.status = "PENDING";
  const buyer = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() } });
  return { ...base, buyerSession: session(buyer.id, "CUSTOMER", BUYER) };
}

describe("media upload (XRPL-070/071)", () => {
  it("refuses an upload without the rights declaration, an unsupported file and an oversized one", async () => {
    const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
    const storage = memoryStorage();
    const upload = (bytes: Uint8Array, rightsConfirmed = true) =>
      uploadMediaAsset(
        { db, storage },
        { session: session(seller.id, "SELLER", null), fileName: "a.png", bytes, rightsConfirmed },
      );

    await expect(upload(PNG, false)).rejects.toMatchObject({ code: "RIGHTS_NOT_CONFIRMED", status: 400 });
    // A script named .png is judged by its bytes, not its name.
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    await expect(upload(html)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
    const huge = new Uint8Array(10 * 1024 * 1024 + 1);
    huge.set(PNG);
    await expect(upload(huge)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    const customer = await db.user.create({ data: { displayName: "Fan", role: "CUSTOMER", onboardedAt: new Date() } });
    await expect(
      uploadMediaAsset(
        { db, storage },
        { session: session(customer.id, "CUSTOMER", null), fileName: "a.png", bytes: PNG, rightsConfirmed: true },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(storage.files.size).toBe(0);
    expect(await db.mediaAsset.count()).toBe(0);
    expect(sniffMediaType(new TextEncoder().encode("ID3\u0004 an mp3 tag........"))).toBe("audio/mpeg");
  });

  it("stores a valid upload with its uploader, type, size and location, and reports failed storage", async () => {
    const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
    const sellerSession = session(seller.id, "SELLER", null);
    const storage = memoryStorage();

    const asset = await uploadMediaAsset(
      { db, storage },
      { session: sellerSession, fileName: "cover.png", bytes: PNG, rightsConfirmed: true },
    );
    expect(asset).toMatchObject({
      uploaderId: seller.id,
      kind: "IMAGE",
      mimeType: "image/png",
      sizeBytes: PNG.length,
      originalName: "cover.png",
    });
    expect(asset.rightsConfirmedAt).toBeInstanceOf(Date);
    expect(asset.storageKey).toMatch(/^[a-f0-9-]{36}\.png$/);
    expect(storage.files.get(asset.storageKey)).toEqual(PNG);

    const broken: MediaStorage = { ...storage, put: async () => Promise.reject(new Error("disk full")) };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      uploadMediaAsset(
        { db, storage: broken },
        { session: sellerSession, fileName: "b.png", bytes: PNG, rightsConfirmed: true },
      ),
    ).rejects.toMatchObject({ code: "MEDIA_STORAGE_FAILED", status: 503 });
    errorLog.mockRestore();
    expect(await db.mediaAsset.count()).toBe(1);
  });

  it("keeps unpublished media private and exposes it once its collectible is published", async () => {
    const seller = await db.user.create({ data: { displayName: "Band", role: "SELLER", onboardedAt: new Date() } });
    const other = await db.user.create({ data: { displayName: "Rival", role: "SELLER", onboardedAt: new Date() } });
    const sellerSession = session(seller.id, "SELLER", SELLER);
    const asset = await uploadMediaAsset(
      { db, storage: memoryStorage() },
      { session: sellerSession, fileName: "cover.png", bytes: PNG, rightsConfirmed: true },
    );
    const draft = await createCollectible(db, sellerSession, {
      mediaAssetId: asset.id,
      title: "Tour poster",
      description: "",
      editionSize: 2,
      priceDrops: "5000000",
    });

    // Draft: only the uploader. Someone else's media can't be attached to a collectible either.
    await expect(findViewableAsset(db, asset.id, null)).rejects.toMatchObject({ status: 404 });
    await expect(findViewableAsset(db, asset.id, other.id)).rejects.toMatchObject({ status: 404 });
    expect((await findViewableAsset(db, asset.id, seller.id)).isPublic).toBe(false);
    await expect(
      createCollectible(db, session(other.id, "SELLER", null), {
        mediaAssetId: asset.id,
        title: "Stolen",
        description: "",
        editionSize: 1,
        priceDrops: "1",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(draft.tokens).toHaveLength(0);

    const published = await updateCollectible({ db, baseUrl: BASE_URL }, sellerSession, draft.id, {
      status: "PUBLISHED",
    });
    expect((await findViewableAsset(db, asset.id, null)).isPublic).toBe(true);
    // One token per edition, each with a stable metadata URI that exists before any mint.
    expect(published.tokens.map((t) => [t.edition, t.mintStatus, t.metadataUri])).toEqual(
      published.tokens.map((t, i) => [i + 1, "NOT_MINTED", `${BASE_URL}/api/collectibles/tokens/${t.id}/metadata`]),
    );
    expect(published.tokens).toHaveLength(2);
    // Published details are frozen: the NFT metadata must not change.
    await expect(
      updateCollectible({ db, baseUrl: BASE_URL }, sellerSession, draft.id, { title: "Renamed" }),
    ).rejects.toMatchObject({ status: 409 });

    const token = published.tokens[0]!;
    const metadata = buildCollectibleMetadata({
      token,
      collectible: published,
      seller: { id: seller.id, displayName: "Band" },
      media: published.media,
      network: "TESTNET",
      baseUrl: BASE_URL,
    });
    expect(metadata).toMatchObject({
      name: "Tour poster #1/2",
      image: `${BASE_URL}/api/assets/${asset.id}/content`,
      creator: { sellerId: seller.id, name: "Band" },
      edition: { number: 1, of: 2 },
      rights: { copyrightTransferred: false, grantsEventEntry: false },
    });
    expect(metadata.rights.statement).toContain("personal, non-commercial use");
  });
});

describe("minting (XRPL-073)", () => {
  it("records the NFT only from the validated mint, and only once", async () => {
    const { sellerSession, collectible } = await publishedCollectible();
    const metadataUri = collectible.tokens[0]!.metadataUri;
    const world: World = { status: "PENDING", tx: {}, holder: SELLER, offerLive: false, metadataUri };
    const { collectibleDeps, created, getValidatedTx } = deps(world);

    const mint = await requestCollectibleMint(collectibleDeps, { session: sellerSession, collectibleId: collectible.id });
    expect(mint.token).toMatchObject({ edition: 1, mintStatus: "PENDING", nftokenId: null });
    expect(created[0]).toMatchObject({
      purpose: "MINT_COLLECTIBLE",
      reference: mint.token.id,
      txjson: { TransactionType: "NFTokenMint", Account: SELLER, NFTokenTaxon: COLLECTIBLE_TAXON, Flags: 8 },
    });
    expect(convertHexToString(created[0]!.txjson.URI as string)).toBe(metadataUri);
    const memo = (created[0]!.txjson.Memos as { Memo: { MemoType: string; MemoData: string } }[])[0]!.Memo;
    expect([convertHexToString(memo.MemoType), convertHexToString(memo.MemoData)]).toEqual([
      COLLECTIBLE_MEMO_TYPE,
      mint.token.id,
    ]);

    // Waiting, then signed but not validated: nothing is recorded as minted.
    expect(await reconcileToken(collectibleDeps, mint.token.id)).toMatchObject({ mintStatus: "PENDING", nftokenId: null });
    Object.assign(world, { status: "SUBMITTED", extra: { txHash: MINT_HASH } });
    expect(await reconcileToken(collectibleDeps, mint.token.id)).toMatchObject({
      mintStatus: "SUBMITTED",
      nftokenId: null,
    });
    expect(getValidatedTx).not.toHaveBeenCalled();

    // Validated tesSUCCESS: recorded from the ledger's own answer.
    Object.assign(world, { status: "CONFIRMED", tx: { nftokenId: NFT_ID } });
    const [first, second] = await Promise.all([
      reconcileToken(collectibleDeps, mint.token.id),
      reconcileToken(collectibleDeps, mint.token.id),
    ]);
    for (const token of [first, second, await reconcileToken(collectibleDeps, mint.token.id)]) {
      expect(token).toMatchObject({
        mintStatus: "MINTED",
        nftokenId: NFT_ID,
        mintTxHash: MINT_HASH,
        issuerAddress: SELLER,
        ownerAddress: SELLER,
      });
    }
    expect(getValidatedTx).toHaveBeenCalledWith(MINT_HASH);
    expect(await db.collectibleToken.count({ where: { nftokenId: NFT_ID } })).toBe(1);
    // The other edition is untouched, and nothing reached the ticket tables check-in reads.
    expect(await db.collectibleToken.count({ where: { mintStatus: "NOT_MINTED" } })).toBe(1);
    expect(await db.ticketNFT.count()).toBe(0);
    expect(await db.nFTOffer.count()).toBe(0);
    expect(await db.ledgerTransaction.count()).toBe(0);
  });

  it("does not record an NFT that is not this collectible's, and frees a declined edition", async () => {
    const { sellerSession, collectible } = await publishedCollectible();
    const metadataUri = collectible.tokens[0]!.metadataUri;
    // A validated mint with a ticket-style taxon is not this collectible's NFT.
    const world: World = {
      status: "CONFIRMED",
      extra: { txHash: MINT_HASH },
      tx: { nftokenId: nftokenIdFor(SELLER, 12345) },
      holder: SELLER,
      offerLive: false,
      metadataUri,
    };
    const { collectibleDeps } = deps(world);
    const mint = await requestCollectibleMint(collectibleDeps, { session: sellerSession, collectibleId: collectible.id });
    await expect(reconcileToken(collectibleDeps, mint.token.id)).rejects.toThrow(/does not match/);
    expect(await db.collectibleToken.findUniqueOrThrow({ where: { id: mint.token.id } })).toMatchObject({
      mintStatus: "PENDING",
      nftokenId: null,
    });

    // Declined in the wallet: no NFT, and the same edition is offered again.
    Object.assign(world, { status: "REJECTED", extra: {} });
    expect(await reconcileToken(collectibleDeps, mint.token.id)).toMatchObject({ mintStatus: "FAILED", nftokenId: null });
    Object.assign(world, { status: "PENDING" });
    const retry = await requestCollectibleMint(collectibleDeps, { session: sellerSession, collectibleId: collectible.id });
    expect(retry.token).toMatchObject({ id: mint.token.id, edition: 1, mintStatus: "PENDING" });
  });
});

describe("selling and buying (XRPL-074/075)", () => {
  it("records a purchase from the validated accept and moves the owner to the buyer", async () => {
    const { collectibleDeps, created, world, tokenId, buyerSession, sellerSession } = await listedToken();

    const purchase = await requestCollectiblePurchase(collectibleDeps, { session: buyerSession, tokenId });
    expect(purchase).toMatchObject({ title: "Tour poster", amountDrops: "5000000" });
    expect(created.at(-1)).toMatchObject({
      purpose: "ACCEPT_COLLECTIBLE_OFFER",
      txjson: { TransactionType: "NFTokenAcceptOffer", Account: BUYER, NFTokenSellOffer: OFFER_INDEX },
    });
    // One purchase in flight per edition.
    await expect(requestCollectiblePurchase(collectibleDeps, { session: buyerSession, tokenId })).rejects.toMatchObject({
      status: 409,
    });

    // Signed but not validated: still the seller's.
    Object.assign(world, { status: "SUBMITTED", extra: { txHash: SALE_HASH } });
    expect(await reconcileToken(collectibleDeps, tokenId)).toMatchObject({ saleStatus: "PENDING", ownerAddress: SELLER });

    // Validated: the NFT moved to the buyer on the ledger.
    Object.assign(world, {
      status: "CONFIRMED",
      tx: {
        transactionType: "NFTokenAcceptOffer",
        account: BUYER,
        nftokenId: NFT_ID,
        acceptedSellOfferIndex: OFFER_INDEX,
      },
      holder: BUYER,
      offerLive: false,
    });
    for (const token of [await reconcileToken(collectibleDeps, tokenId), await reconcileToken(collectibleDeps, tokenId)]) {
      expect(token).toMatchObject({
        saleStatus: "SOLD",
        saleTxHash: SALE_HASH,
        offerStatus: "ACCEPTED",
        ownerAddress: BUYER,
        saleBuyerAddress: BUYER,
      });
    }

    // The buyer's collection shows it; the seller's no longer does. It is never a ticket.
    const owned = await listOwnedCollectibles(collectibleDeps, { address: BUYER });
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({
      ownerAddress: BUYER,
      verifiedLedgerIndex: 1235,
      token: { id: tokenId, nftokenId: NFT_ID, edition: 1, editionSize: 2 },
      collectible: { title: "Tour poster", sellerName: "Band" },
    });
    expect(await listOwnedCollectibles(collectibleDeps, { address: SELLER })).toHaveLength(0);
    expect(await db.ticketNFT.count()).toBe(0);
    // A sold edition can't be listed or bought again through the app.
    await expect(requestCollectibleSale(collectibleDeps, { session: sellerSession, tokenId })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses a stale offer before asking the buyer's wallet, and says it is gone", async () => {
    const { collectibleDeps, create, world, tokenId, buyerSession } = await listedToken();
    const asked = create.mock.calls.length;
    // Taken or cancelled outside the app.
    world.offerLive = false;

    await expect(requestCollectiblePurchase(collectibleDeps, { session: buyerSession, tokenId })).rejects.toMatchObject({
      status: 409,
      message: STALE_OFFER_MESSAGE,
    });
    expect(create.mock.calls.length).toBe(asked);
    expect(await db.collectibleToken.findUniqueOrThrow({ where: { id: tokenId } })).toMatchObject({
      offerStatus: "STALE",
      saleStatus: "NONE",
      ownerAddress: SELLER,
    });
    // Still refused on the next try, without another wallet request.
    await expect(requestCollectiblePurchase(collectibleDeps, { session: buyerSession, tokenId })).rejects.toMatchObject({
      status: 409,
      message: STALE_OFFER_MESSAGE,
    });
    expect(create.mock.calls.length).toBe(asked);
  });
});
