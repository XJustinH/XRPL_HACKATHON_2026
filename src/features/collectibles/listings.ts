import { randomUUID } from "node:crypto";

import {
  DEFAULT_RIGHTS_STATEMENT,
  type CollectibleTokenView,
  type CollectibleView,
  type CreateCollectibleBody,
  type UpdateCollectibleBody,
} from "@/contracts/collectibles";
import type { Collectible, CollectibleToken, MediaAsset, PrismaClient } from "@/generated/prisma/client";
import { requireEventManager } from "@/lib/auth/permissions";
import type { AuthSession } from "@/lib/auth/session";
import { errors } from "@/lib/http/response";
import type { XrplConfig } from "@/lib/xrpl/config";
import { explorerNftUrl, explorerTxUrl } from "@/lib/xrpl/explorer";

import { toMediaAssetView } from "./assets";
import { collectibleMetadataUrl } from "./metadata";

/**
 * Collectible listings (XRPL-072): a seller describes uploaded media as a numbered edition,
 * then publishes it. Publishing makes the media and metadata public, fixes the details the NFT
 * metadata is built from, and creates one token per edition with its stable metadata URI.
 */

type ExplorerConfig = Pick<XrplConfig, "explorerUrl">;

export const COLLECTIBLE_INCLUDE = {
  media: true,
  seller: { select: { displayName: true } },
  tokens: { orderBy: { edition: "asc" } },
} as const;

export type CollectibleRow = Collectible & {
  media: MediaAsset;
  seller: { displayName: string };
  tokens: CollectibleToken[];
};

const iso = (date: Date | null) => (date ? date.toISOString() : null);

/** A sell offer is on the ledger and nobody has bought the edition. */
export function isForSale(token: Pick<CollectibleToken, "offerStatus" | "saleStatus" | "offerIndex">): boolean {
  return token.offerStatus === "ACTIVE" && token.saleStatus !== "SOLD" && !!token.offerIndex;
}

export function toTokenView(
  token: CollectibleToken,
  editionSize: number,
  config: ExplorerConfig,
): CollectibleTokenView {
  return {
    id: token.id,
    collectibleId: token.collectibleId,
    edition: token.edition,
    editionSize,
    metadataUri: token.metadataUri,
    mintStatus: token.mintStatus,
    nftokenId: token.nftokenId,
    issuerAddress: token.issuerAddress,
    mintedAt: iso(token.mintedAt),
    offerStatus: token.offerStatus,
    offerIndex: token.offerIndex,
    offerAmountDrops: token.offerAmountDrops,
    saleStatus: token.saleStatus,
    saleTxHash: token.saleTxHash,
    soldAt: iso(token.soldAt),
    forSale: isForSale(token),
    nftExplorerUrl: token.nftokenId ? explorerNftUrl(config, token.nftokenId) : null,
    mintTxExplorerUrl: token.mintTxHash ? explorerTxUrl(config, token.mintTxHash) : null,
    offerTxExplorerUrl: token.offerTxHash ? explorerTxUrl(config, token.offerTxHash) : null,
    saleTxExplorerUrl: token.saleTxHash ? explorerTxUrl(config, token.saleTxHash) : null,
  };
}

/** A listing without its tokens (e.g. beside one owned token). */
export function toCollectibleSummary(
  row: Omit<CollectibleRow, "tokens">,
): Omit<CollectibleView, "tokens" | "mintedCount" | "forSaleCount"> {
  return {
    id: row.id,
    sellerId: row.sellerId,
    sellerName: row.seller.displayName,
    title: row.title,
    description: row.description,
    editionSize: row.editionSize,
    priceDrops: row.priceDrops,
    rightsStatement: row.rightsStatement,
    status: row.status,
    publishedAt: iso(row.publishedAt),
    createdAt: row.createdAt.toISOString(),
    media: toMediaAssetView(row.media),
  };
}

export function toCollectibleView(row: CollectibleRow, config: ExplorerConfig): CollectibleView {
  return {
    ...toCollectibleSummary(row),
    tokens: row.tokens.map((token) => toTokenView(token, row.editionSize, config)),
    mintedCount: row.tokens.filter((t) => t.mintStatus === "MINTED").length,
    forSaleCount: row.tokens.filter(isForSale).length,
  };
}

/** The collectible, if `session` is its seller: 404 if it does not exist, 403 otherwise. */
export async function requireOwnCollectible(
  db: Pick<PrismaClient, "collectible">,
  session: AuthSession,
  collectibleId: string,
): Promise<Collectible> {
  requireEventManager(session);
  const collectible = await db.collectible.findUnique({ where: { id: collectibleId } });
  if (!collectible) throw errors.notFound("Collectible not found");
  if (collectible.sellerId !== session.userId) {
    throw errors.forbidden("Only the collectible's seller can do this");
  }
  return collectible;
}

/** Creates a draft from media the seller uploaded (with its rights declaration) themselves. */
export async function createCollectible(
  db: PrismaClient,
  session: AuthSession,
  body: CreateCollectibleBody,
): Promise<CollectibleRow> {
  requireEventManager(session);
  const media = await db.mediaAsset.findUnique({ where: { id: body.mediaAssetId } });
  if (!media || media.uploaderId !== session.userId) throw errors.notFound("Media not found");
  return db.collectible.create({
    data: {
      sellerId: session.userId,
      mediaAssetId: media.id,
      title: body.title,
      description: body.description,
      editionSize: body.editionSize,
      priceDrops: body.priceDrops,
      rightsStatement: body.rightsStatement || DEFAULT_RIGHTS_STATEMENT,
    },
    include: COLLECTIBLE_INCLUDE,
  });
}

/**
 * Edits a draft and/or publishes it. A published collectible keeps its title, description,
 * edition size and rights statement for good (409): its NFTs point at metadata built from them.
 */
export async function updateCollectible(
  deps: { db: PrismaClient; baseUrl: string },
  session: AuthSession,
  collectibleId: string,
  body: UpdateCollectibleBody,
): Promise<CollectibleRow> {
  const current = await requireOwnCollectible(deps.db, session, collectibleId);
  const { status, ...edits } = body;

  if (current.status === "PUBLISHED") {
    const { priceDrops, ...frozen } = edits;
    if (Object.values(frozen).some((value) => value !== undefined)) {
      throw errors.conflict(
        "A published collectible can't be edited: its NFT metadata must stay the same. Only the price can change.",
      );
    }
    if (priceDrops !== undefined) {
      await deps.db.collectible.update({ where: { id: current.id }, data: { priceDrops } });
    }
  } else {
    await deps.db.$transaction(async (tx) => {
      // Lock the row: only a draft is edited, and it is published only once.
      await tx.$queryRaw`SELECT "id" FROM "Collectible" WHERE "id" = ${current.id}::uuid FOR UPDATE`;
      const locked = await tx.collectible.findUniqueOrThrow({ where: { id: current.id }, select: { status: true } });
      if (locked.status !== "DRAFT") throw errors.conflict("This collectible has just been published");
      const updated = await tx.collectible.update({
        where: { id: current.id },
        data: { ...edits, ...(status === "PUBLISHED" ? { status: "PUBLISHED", publishedAt: new Date() } : {}) },
      });
      if (status !== "PUBLISHED") return;
      await tx.collectibleToken.createMany({
        data: Array.from({ length: updated.editionSize }, (_, index) => {
          const id = randomUUID();
          return {
            id,
            collectibleId: current.id,
            edition: index + 1,
            metadataUri: collectibleMetadataUrl(deps.baseUrl, id),
          };
        }),
      });
    });
  }
  return deps.db.collectible.findUniqueOrThrow({ where: { id: current.id }, include: COLLECTIBLE_INCLUDE });
}

/** A published collectible, or the viewer's own draft. Anything else is 404. */
export async function findCollectible(
  db: Pick<PrismaClient, "collectible">,
  collectibleId: string,
  viewerUserId: string | null,
): Promise<CollectibleRow> {
  const row = await db.collectible.findUnique({ where: { id: collectibleId }, include: COLLECTIBLE_INCLUDE });
  if (!row || (row.status !== "PUBLISHED" && row.sellerId !== viewerUserId)) {
    throw errors.notFound("Collectible not found");
  }
  return row;
}

/** A seller's collectibles, newest first. Drafts only for the seller's own management view. */
export function listSellerCollectibles(
  db: Pick<PrismaClient, "collectible">,
  sellerId: string,
  options: { includeDrafts: boolean },
): Promise<CollectibleRow[]> {
  return db.collectible.findMany({
    where: { sellerId, ...(options.includeDrafts ? {} : { status: "PUBLISHED" }) },
    include: COLLECTIBLE_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/** Published collectibles from every seller, newest first. */
export function listPublishedCollectibles(
  db: Pick<PrismaClient, "collectible">,
  limit = 24,
): Promise<CollectibleRow[]> {
  return db.collectible.findMany({
    where: { status: "PUBLISHED" },
    include: COLLECTIBLE_INCLUDE,
    orderBy: { publishedAt: "desc" },
    take: limit,
  });
}
