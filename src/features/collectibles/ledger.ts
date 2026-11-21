import { convertStringToHex, NFTokenCreateOfferFlags, parseNFTokenID } from "xrpl";

import type {
  CollectibleMintResult,
  CollectibleRequestResult,
  CollectibleTokenView,
  OwnedCollectible,
} from "@/contracts/collectibles";
import type { TransactionRequest } from "@/contracts/xrpl";
import type { CollectibleToken, Prisma, PrismaClient } from "@/generated/prisma/client";
import { requireProvenWallet } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { errors } from "@/lib/http/response";
import type { XrplConfig } from "@/lib/xrpl/config";
import { formatDropsAsXrp } from "@/lib/xrpl/format";
import type { XrplQueryService } from "@/lib/xrpl/query";
import { encodeNftUri } from "@/lib/xrpl/tickets/metadata";
import { isPubliclyReachable } from "@/lib/xrpl/tickets/urls";
import { getWalletReadiness } from "@/lib/xrpl/wallet/readiness";
import type { WalletTransactionRequests } from "@/lib/xrpl/wallet/transaction-requests";

import { requireOwnCollectible, toCollectibleSummary, toTokenView } from "./listings";
import { COLLECTIBLE_MEMO_TYPE, COLLECTIBLE_NFT_FLAGS, COLLECTIBLE_TAXON } from "./metadata";

/**
 * Minting, selling and buying collectible NFTs (XRPL-073/074), and reading what a wallet owns
 * (XRPL-075). Mirrors the ticket flows in miniature, on its own tables:
 *
 * - the server builds every transaction and asks the session's proven wallet to sign it in Xaman;
 * - a mint, a sale listing and a purchase are each recorded only from `getValidatedTx` (validated,
 *   tesSUCCESS), exactly once: the update is conditional on the token still waiting for that request;
 * - nothing here reads or writes TicketNFT, NFTOffer or LedgerTransaction, so collectibles never
 *   reach ticket lists, inventory or check-in.
 */

export interface CollectibleDeps {
  db: PrismaClient;
  /** Lazy, so listings work even when Xaman is not configured. */
  transactions: () => Pick<WalletTransactionRequests, "create" | "get">;
  ledger: () => Pick<
    XrplQueryService,
    "getValidatedTx" | "verifyOwner" | "getOffers" | "getAccountInfo" | "getReserves"
  >;
  config: Pick<XrplConfig, "network" | "explorerUrl" | "networkLabel">;
  /** Public base URL for metadata URIs (`ticketPublicBaseUrl()`). */
  baseUrl: string;
}

/** A claim whose wallet request was never created (e.g. a crash) is released after this. */
const ORPHAN_HOLD_MS = 2 * 60 * 1000;
const MAX_INSTRUCTION_LENGTH = 280;
const MAX_RECONCILE_PER_REQUEST = 20;
const MAX_OWNED_CHECKS = 50;

export const STALE_OFFER_MESSAGE =
  "This edition is no longer for sale: its offer was taken or withdrawn on the XRP Ledger. Nothing was charged. Pick another edition.";

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const memoFor = (tokenId: string) => [
  { Memo: { MemoType: convertStringToHex(COLLECTIBLE_MEMO_TYPE), MemoData: convertStringToHex(tokenId) } },
];

async function loadToken(db: PrismaClient, tokenId: string) {
  const token = await db.collectibleToken.findUnique({ where: { id: tokenId }, include: { collectible: true } });
  if (!token) throw errors.notFound("Collectible not found");
  return token;
}

// ---------------------------------------------------------------------------
// Mint (XRPL-073)
// ---------------------------------------------------------------------------

/**
 * Claims the next unminted edition and asks the seller's wallet to sign its NFTokenMint. Only the
 * collectible's seller may mint, only once it is published, and only with the wallet this session
 * has proven: that wallet is the issuer, never an address sent by the browser.
 * 404 / 403 not the seller · 403 WALLET_NOT_VERIFIED · 409 draft, or every edition is minted.
 */
export async function requestCollectibleMint(
  deps: CollectibleDeps,
  input: { session: AuthSession; collectibleId: string },
): Promise<CollectibleMintResult> {
  const collectible = await requireOwnCollectible(deps.db, input.session, input.collectibleId);
  if (collectible.status !== "PUBLISHED") {
    throw errors.conflict("Publish the collectible before minting it: the NFT links to its public metadata.");
  }
  const issuer = requireProvenWallet(input.session);

  // Settle earlier attempts first: a declined or expired mint frees its edition.
  await reconcileCollectible(deps, collectible.id);

  const token = await deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${collectible.id}::uuid FOR UPDATE`;
    const next = await tx.collectibleToken.findFirst({
      where: { collectibleId: collectible.id, mintStatus: { in: ["NOT_MINTED", "FAILED"] }, nftokenId: null },
      orderBy: { edition: "asc" },
    });
    if (!next) {
      throw errors.conflict(`All ${collectible.editionSize} editions are minted or waiting for approval.`);
    }
    return tx.collectibleToken.update({
      where: { id: next.id },
      data: { mintStatus: "PENDING", mintRequestId: null, issuerAddress: issuer },
    });
  });

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "MINT_COLLECTIBLE",
      txjson: {
        TransactionType: "NFTokenMint",
        Account: issuer,
        NFTokenTaxon: COLLECTIBLE_TAXON,
        Flags: COLLECTIBLE_NFT_FLAGS,
        URI: encodeNftUri(token.metadataUri),
        Memos: memoFor(token.id),
      },
      instruction: truncate(
        `Mint digital collectible: ${collectible.title} #${token.edition} of ${collectible.editionSize} (not a ticket)`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: token.id,
    });
  } catch (error) {
    // No sign request exists, so release the edition for the next attempt.
    await deps.db.collectibleToken.updateMany({
      where: { id: token.id, mintStatus: "PENDING", mintRequestId: null },
      data: { mintStatus: "FAILED" },
    });
    throw error;
  }
  const saved = await deps.db.collectibleToken.update({
    where: { id: token.id },
    data: { mintRequestId: request.id },
  });
  return {
    token: toTokenView(saved, collectible.editionSize, deps.config),
    request,
    metadataPublic: isPubliclyReachable(token.metadataUri),
  };
}

async function reconcileMint(deps: CollectibleDeps, token: CollectibleToken): Promise<void> {
  if (!token.mintRequestId) {
    if (Date.now() - token.updatedAt.getTime() > ORPHAN_HOLD_MS) {
      await deps.db.collectibleToken.updateMany({
        where: { id: token.id, mintStatus: "PENDING", mintRequestId: null },
        data: { mintStatus: "FAILED" },
      });
    }
    return;
  }
  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(token.mintRequestId);
  } catch {
    return; // Wallet service unreachable: try again on the next read.
  }
  const waiting = { id: token.id, mintRequestId: request.id, nftokenId: null };

  switch (request.status) {
    case "PENDING":
    case "OPENED":
      return;
    case "SUBMITTED":
      await deps.db.collectibleToken.updateMany({
        where: { ...waiting, mintStatus: "PENDING" },
        data: { mintStatus: "SUBMITTED" },
      });
      return;
    case "CONFIRMED":
      break;
    default:
      // Declined, expired, cancelled, or rejected by the network: no NFT exists.
      await deps.db.collectibleToken.updateMany({
        where: { ...waiting, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
        data: { mintStatus: "FAILED" },
      });
      return;
  }

  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenMint" || !confirmed.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} is not a mint with an NFTokenID`);
  }
  const issuer = confirmed.account;
  const parsed = parseNFTokenID(confirmed.nftokenId);
  if (issuer !== token.issuerAddress || parsed.Issuer !== issuer || parsed.Taxon !== COLLECTIBLE_TAXON) {
    throw new Error(`NFT ${confirmed.nftokenId} does not match collectible token ${token.id}`);
  }
  const holding = await deps.ledger().verifyOwner(confirmed.nftokenId, issuer);
  if (holding.owns && holding.nft?.uri !== token.metadataUri) {
    throw new Error(`NFT ${confirmed.nftokenId} does not point at collectible token ${token.id}'s metadata`);
  }
  const now = new Date();
  // Conditional on the token still waiting for this request: applied once, however often it runs.
  await deps.db.collectibleToken.updateMany({
    where: { ...waiting, mintStatus: { in: ["PENDING", "SUBMITTED"] } },
    data: {
      mintStatus: "MINTED",
      nftokenId: confirmed.nftokenId,
      mintTxHash: confirmed.hash,
      mintedAt: confirmed.closeTime ? new Date(confirmed.closeTime) : now,
      ownerAddress: holding.owns ? issuer : null,
      ownerVerifiedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Sell offer (XRPL-074)
// ---------------------------------------------------------------------------

type OfferedToken = Pick<CollectibleToken, "nftokenId" | "offerIndex" | "offerAmountDrops" | "ownerAddress">;

/** Is the token's sell offer still on the ledger as recorded, and does the seller still hold the NFT? */
async function isOfferLive(deps: Pick<CollectibleDeps, "ledger">, token: OfferedToken): Promise<boolean> {
  if (!token.nftokenId || !token.offerIndex || !token.ownerAddress) return false;
  const live = await deps.ledger().getOffers(token.nftokenId);
  const onLedger = live.sellOffers.find((offer) => offer.offerIndex === token.offerIndex);
  if (
    !onLedger ||
    onLedger.owner !== token.ownerAddress ||
    onLedger.amountDrops !== token.offerAmountDrops ||
    onLedger.destination !== null ||
    (onLedger.expiresAt !== null && new Date(onLedger.expiresAt) <= new Date())
  ) {
    return false;
  }
  return (await deps.ledger().verifyOwner(token.nftokenId, token.ownerAddress)).owns;
}

const markStale = (db: PrismaClient, token: Pick<CollectibleToken, "id" | "offerIndex">) =>
  db.collectibleToken.updateMany({
    where: { id: token.id, offerStatus: "ACTIVE", offerIndex: token.offerIndex },
    data: { offerStatus: "STALE" },
  });

/**
 * Asks the seller's wallet to sign an XRPL sell offer for one minted edition, at the collectible's
 * price. The seller's proven wallet must hold the NFT on the ledger right now.
 * 404 / 403 not the seller · 403 WALLET_NOT_VERIFIED · 409 not minted, sold, already listed, or
 * the wallet does not hold the NFT.
 */
export async function requestCollectibleSale(
  deps: CollectibleDeps,
  input: { session: AuthSession; tokenId: string },
): Promise<CollectibleRequestResult> {
  const { collectibleId } = await loadToken(deps.db, input.tokenId);
  const collectible = await requireOwnCollectible(deps.db, input.session, collectibleId);
  const wallet = requireProvenWallet(input.session);

  const token = await reconcileToken(deps, input.tokenId);
  if (token.mintStatus !== "MINTED" || !token.nftokenId) {
    throw errors.conflict("Mint this edition before listing it for sale.");
  }
  if (token.saleStatus === "SOLD") throw errors.conflict("This edition has already been sold.");
  if (token.saleStatus === "PENDING") throw errors.conflict("A buyer is approving this purchase right now.");
  if (token.offerStatus === "PENDING") {
    throw errors.conflict("A sale listing for this edition is already waiting for approval in Xaman.");
  }
  if (token.offerStatus === "ACTIVE") {
    if (await isOfferLive(deps, token)) throw errors.conflict("This edition is already listed for sale.");
    await markStale(deps.db, token);
  }
  const holding = await deps.ledger().verifyOwner(token.nftokenId, wallet);
  if (!holding.owns) {
    throw errors.conflict("Your connected wallet does not hold this collectible's NFT, so it can't list it for sale.");
  }

  const amountDrops = collectible.priceDrops;
  const claimed = await deps.db.collectibleToken.updateMany({
    where: { id: token.id, offerStatus: { in: ["NONE", "FAILED", "STALE"] }, saleStatus: "NONE" },
    data: {
      offerStatus: "PENDING",
      offerRequestId: null,
      offerIndex: null,
      offerTxHash: null,
      offerAmountDrops: amountDrops,
      ownerAddress: wallet,
      ownerVerifiedAt: new Date(),
    },
  });
  if (claimed.count === 0) throw errors.conflict("This edition is already being listed for sale.");

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "CREATE_COLLECTIBLE_OFFER",
      txjson: {
        TransactionType: "NFTokenCreateOffer",
        Account: wallet,
        NFTokenID: token.nftokenId,
        Amount: amountDrops,
        Flags: NFTokenCreateOfferFlags.tfSellNFToken,
        Memos: memoFor(token.id),
      },
      instruction: truncate(
        `List digital collectible for sale: ${collectible.title} #${token.edition} of ${collectible.editionSize} for ${formatDropsAsXrp(amountDrops)} XRP`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: token.id,
    });
  } catch (error) {
    await deps.db.collectibleToken.updateMany({
      where: { id: token.id, offerStatus: "PENDING", offerRequestId: null },
      data: { offerStatus: "FAILED" },
    });
    throw error;
  }
  const saved = await deps.db.collectibleToken.update({
    where: { id: token.id },
    data: { offerRequestId: request.id },
  });
  return {
    token: toTokenView(saved, collectible.editionSize, deps.config),
    request,
    title: collectible.title,
    amountDrops,
  };
}

async function reconcileOffer(deps: CollectibleDeps, token: CollectibleToken): Promise<void> {
  if (!token.offerRequestId) {
    if (Date.now() - token.updatedAt.getTime() > ORPHAN_HOLD_MS) {
      await deps.db.collectibleToken.updateMany({
        where: { id: token.id, offerStatus: "PENDING", offerRequestId: null },
        data: { offerStatus: "FAILED" },
      });
    }
    return;
  }
  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(token.offerRequestId);
  } catch {
    return;
  }
  const waiting = { id: token.id, offerRequestId: request.id, offerStatus: "PENDING" as const };
  if (request.status === "PENDING" || request.status === "OPENED" || request.status === "SUBMITTED") return;
  if (request.status !== "CONFIRMED") {
    await deps.db.collectibleToken.updateMany({ where: waiting, data: { offerStatus: "FAILED" } });
    return;
  }

  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenCreateOffer" || !confirmed.offerIndex || !token.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} did not create an NFT offer`);
  }
  if (confirmed.account !== token.ownerAddress) {
    throw new Error(`Collectible offer ${token.id} was signed by ${confirmed.account}, not ${token.ownerAddress}`);
  }
  // The live offer must be the one the app asked for: this NFT, a sell offer open to anyone, at the price.
  const live = await deps.ledger().getOffers(token.nftokenId);
  const onLedger = live.sellOffers.find((offer) => offer.offerIndex === confirmed.offerIndex) ?? null;
  if (
    onLedger &&
    (onLedger.owner !== confirmed.account ||
      onLedger.amountDrops !== token.offerAmountDrops ||
      onLedger.destination !== null)
  ) {
    throw new Error(`Offer ${confirmed.offerIndex} on the ledger does not match collectible token ${token.id}`);
  }
  await deps.db.collectibleToken.updateMany({
    where: waiting,
    data: {
      // Already gone (accepted or cancelled outside the app): created on the ledger, but not for sale here.
      offerStatus: onLedger ? "ACTIVE" : "STALE",
      offerIndex: confirmed.offerIndex,
      offerTxHash: confirmed.hash,
    },
  });
}

// ---------------------------------------------------------------------------
// Purchase (XRPL-074)
// ---------------------------------------------------------------------------

/**
 * Prepares the buyer's approval of an edition's sell offer. Before the wallet is asked, the offer
 * is re-checked on the ledger: one that was taken or withdrawn is marked STALE and refused (409),
 * and the buyer must be able to pay. One purchase is in flight per edition.
 * 403 WALLET_NOT_VERIFIED · 404 unknown or unpublished · 409 not for sale, stale, own wallet,
 * can't pay, or someone is already buying it.
 */
export async function requestCollectiblePurchase(
  deps: CollectibleDeps,
  input: { session: AuthSession; tokenId: string },
): Promise<CollectibleRequestResult> {
  const buyer = requireProvenWallet(input.session);
  const { collectible } = await loadToken(deps.db, input.tokenId);
  if (collectible.status !== "PUBLISHED") throw errors.notFound("Collectible not found");

  // Settle earlier attempts first: a declined or expired purchase frees the edition.
  const token = await reconcileToken(deps, input.tokenId);
  if (token.saleStatus === "SOLD") throw errors.conflict("This edition has already been sold.");
  if (token.saleStatus === "PENDING") {
    throw errors.conflict(
      token.saleBuyerAddress === buyer
        ? "You already have a purchase of this edition waiting in Xaman. Approve or cancel it there first."
        : "Someone is buying this edition right now. Pick another one, or try again in a few minutes.",
    );
  }
  if (token.offerStatus === "STALE") throw errors.conflict(STALE_OFFER_MESSAGE);
  if (token.offerStatus !== "ACTIVE" || !token.offerIndex || !token.offerAmountDrops) {
    throw errors.conflict("This edition is not for sale.");
  }
  if (buyer === token.ownerAddress) throw errors.conflict("You can't buy a collectible from your own wallet.");

  // Re-check the live offer: it may have been taken or withdrawn outside the app.
  if (!(await isOfferLive(deps, token))) {
    await markStale(deps.db, token);
    throw errors.conflict(STALE_OFFER_MESSAGE);
  }
  const readiness = await getWalletReadiness(deps.ledger(), deps.config, {
    address: buyer,
    requiredDrops: token.offerAmountDrops,
  });
  if (!readiness.canPurchase) {
    throw errors.conflict(readiness.blockers[0] ?? "This wallet can't pay for the collectible right now.");
  }

  const claimed = await deps.db.collectibleToken.updateMany({
    where: { id: token.id, offerStatus: "ACTIVE", offerIndex: token.offerIndex, saleStatus: "NONE" },
    data: { saleStatus: "PENDING", saleRequestId: null, saleBuyerAddress: buyer },
  });
  if (claimed.count === 0) {
    throw errors.conflict("Someone is buying this edition right now. Pick another one, or try again in a few minutes.");
  }

  let request: TransactionRequest;
  try {
    request = await deps.transactions().create({
      purpose: "ACCEPT_COLLECTIBLE_OFFER",
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
        Account: buyer,
        NFTokenSellOffer: token.offerIndex,
        Memos: memoFor(token.id),
      },
      instruction: truncate(
        `Buy digital collectible: ${collectible.title} #${token.edition} of ${collectible.editionSize} for ${formatDropsAsXrp(token.offerAmountDrops)} XRP (not a ticket)`,
        MAX_INSTRUCTION_LENGTH,
      ),
      reference: token.id,
    });
  } catch (error) {
    await deps.db.collectibleToken.updateMany({
      where: { id: token.id, saleStatus: "PENDING", saleRequestId: null, saleBuyerAddress: buyer },
      data: { saleStatus: "NONE", saleBuyerAddress: null },
    });
    throw error;
  }
  const saved = await deps.db.collectibleToken.update({
    where: { id: token.id },
    data: { saleRequestId: request.id },
  });
  return {
    token: toTokenView(saved, collectible.editionSize, deps.config),
    request,
    title: collectible.title,
    amountDrops: token.offerAmountDrops,
  };
}

async function reconcileSale(deps: CollectibleDeps, token: CollectibleToken): Promise<void> {
  const release = { saleStatus: "NONE" as const, saleRequestId: null, saleBuyerAddress: null };
  if (!token.saleRequestId) {
    if (Date.now() - token.updatedAt.getTime() > ORPHAN_HOLD_MS) {
      await deps.db.collectibleToken.updateMany({
        where: { id: token.id, saleStatus: "PENDING", saleRequestId: null },
        data: release,
      });
    }
    return;
  }
  let request: TransactionRequest;
  try {
    request = await deps.transactions().get(token.saleRequestId);
  } catch {
    return;
  }
  const waiting = { id: token.id, saleRequestId: request.id, saleStatus: "PENDING" as const };
  if (request.status === "PENDING" || request.status === "OPENED" || request.status === "SUBMITTED") return;
  if (request.status !== "CONFIRMED") {
    // Declined, expired, cancelled or failed: free the edition, then see if its offer survived.
    const released = await deps.db.collectibleToken.updateMany({ where: waiting, data: release });
    if (released.count === 1 && !(await isOfferLive(deps, token))) await markStale(deps.db, token);
    return;
  }

  // Re-check through the single "confirmed" gate before writing anything.
  const confirmed = await deps.ledger().getValidatedTx(request.txHash as string);
  if (confirmed.transactionType !== "NFTokenAcceptOffer" || !token.nftokenId || confirmed.nftokenId !== token.nftokenId) {
    throw new Error(`Transaction ${confirmed.hash} did not transfer NFT ${token.nftokenId}`);
  }
  if (confirmed.acceptedSellOfferIndex !== null && confirmed.acceptedSellOfferIndex !== token.offerIndex) {
    throw new Error(`Transaction ${confirmed.hash} accepted a different offer than ${token.offerIndex}`);
  }
  if (confirmed.account !== token.saleBuyerAddress) {
    throw new Error(`Collectible purchase ${token.id} was signed by ${confirmed.account}, not ${token.saleBuyerAddress}`);
  }
  const buyer = confirmed.account;
  const holding = await deps.ledger().verifyOwner(token.nftokenId, buyer);
  const now = new Date();
  await deps.db.collectibleToken.updateMany({
    where: waiting,
    data: {
      saleStatus: "SOLD",
      saleTxHash: confirmed.hash,
      soldAt: confirmed.closeTime ? new Date(confirmed.closeTime) : now,
      offerStatus: "ACCEPTED",
      ownerAddress: holding.owns ? buyer : null,
      ownerVerifiedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Reconciling and reading
// ---------------------------------------------------------------------------

const IN_FLIGHT: Prisma.CollectibleTokenWhereInput = {
  OR: [{ mintStatus: { in: ["PENDING", "SUBMITTED"] } }, { offerStatus: "PENDING" }, { saleStatus: "PENDING" }],
};

/**
 * Brings one token up to date with its wallet request and the ledger: the mint, then the sale
 * listing, then the purchase (only one can be in flight). Safe to call repeatedly and concurrently.
 */
export async function reconcileToken(deps: CollectibleDeps, tokenId: string): Promise<CollectibleToken> {
  const token = await deps.db.collectibleToken.findUnique({ where: { id: tokenId } });
  if (!token) throw errors.notFound("Collectible not found");
  if (token.mintStatus === "PENDING" || token.mintStatus === "SUBMITTED") await reconcileMint(deps, token);
  else if (token.offerStatus === "PENDING") await reconcileOffer(deps, token);
  else if (token.saleStatus === "PENDING") await reconcileSale(deps, token);
  else return token;
  return deps.db.collectibleToken.findUniqueOrThrow({ where: { id: tokenId } });
}

/** Reconciles a set of tokens in flight (bounded per call). One failure never blocks the rest. */
async function reconcileWhere(deps: CollectibleDeps, where: Prisma.CollectibleTokenWhereInput): Promise<void> {
  const inFlight = await deps.db.collectibleToken.findMany({
    where: { AND: [where, IN_FLIGHT] },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: MAX_RECONCILE_PER_REQUEST,
  });
  for (const { id } of inFlight) {
    try {
      await reconcileToken(deps, id);
    } catch (error) {
      console.error(`[collectibles] could not reconcile token ${id}`, error);
    }
  }
}

export const reconcileCollectible = (deps: CollectibleDeps, collectibleId: string) =>
  reconcileWhere(deps, { collectibleId });

export const reconcileSellerCollectibles = (deps: CollectibleDeps, sellerId: string) =>
  reconcileWhere(deps, { collectible: { sellerId } });

/** One token after reconciling it (`GET /api/collectibles/tokens/:id`). Published collectibles only. */
export async function getTokenStatus(deps: CollectibleDeps, tokenId: string): Promise<CollectibleTokenView> {
  const { collectible } = await loadToken(deps.db, tokenId);
  if (collectible.status !== "PUBLISHED") throw errors.notFound("Collectible not found");
  const token = await reconcileToken(deps, tokenId);
  return toTokenView(token, collectible.editionSize, deps.config);
}

/**
 * The collectible NFTs `address` holds right now (XRPL-075). Candidates are the tokens the app
 * recorded for that wallet from validated mints and purchases; each one is then checked on a
 * validated ledger with `verifyOwner`, and only those the wallet still holds are returned.
 * A token it no longer holds is dropped from the wallet's record.
 */
export async function listOwnedCollectibles(
  deps: CollectibleDeps,
  input: { address: string },
): Promise<OwnedCollectible[]> {
  // A purchase this wallet approved may have validated while the page was closed.
  await reconcileWhere(deps, { saleBuyerAddress: input.address });

  const candidates = await deps.db.collectibleToken.findMany({
    where: { ownerAddress: input.address, mintStatus: "MINTED", nftokenId: { not: null } },
    include: { collectible: { include: { media: true, seller: { select: { displayName: true } } } } },
    orderBy: { updatedAt: "desc" },
    take: MAX_OWNED_CHECKS,
  });
  const now = new Date();
  const checked = await Promise.all(
    candidates.map(async ({ collectible, ...token }) => {
      const holding = await deps.ledger().verifyOwner(token.nftokenId as string, input.address);
      if (!holding.owns) {
        await deps.db.collectibleToken.updateMany({
          where: { id: token.id, ownerAddress: input.address },
          data: { ownerAddress: null, ownerVerifiedAt: now },
        });
        return null;
      }
      return {
        token: toTokenView(token, collectible.editionSize, deps.config),
        collectible: toCollectibleSummary(collectible),
        ownerAddress: input.address,
        verifiedLedgerIndex: holding.provenance.ledgerIndex,
        verifiedAt: now.toISOString(),
      } satisfies OwnedCollectible;
    }),
  );
  return checked.filter((item): item is NonNullable<typeof item> => item !== null);
}
