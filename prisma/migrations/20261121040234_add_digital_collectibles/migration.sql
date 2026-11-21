-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CollectibleStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "CollectibleMintStatus" AS ENUM ('NOT_MINTED', 'PENDING', 'SUBMITTED', 'MINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CollectibleOfferStatus" AS ENUM ('NONE', 'PENDING', 'ACTIVE', 'ACCEPTED', 'FAILED', 'STALE');

-- CreateEnum
CREATE TYPE "CollectibleSaleStatus" AS ENUM ('NONE', 'PENDING', 'SOLD');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "rightsConfirmedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collectible" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "editionSize" INTEGER NOT NULL,
    "priceDrops" TEXT NOT NULL,
    "rightsStatement" TEXT NOT NULL,
    "status" "CollectibleStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Collectible_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectibleToken" (
    "id" UUID NOT NULL,
    "collectibleId" UUID NOT NULL,
    "edition" INTEGER NOT NULL,
    "metadataUri" TEXT NOT NULL,
    "mintStatus" "CollectibleMintStatus" NOT NULL DEFAULT 'NOT_MINTED',
    "mintRequestId" TEXT,
    "mintTxHash" TEXT,
    "nftokenId" TEXT,
    "issuerAddress" TEXT,
    "mintedAt" TIMESTAMPTZ(3),
    "offerStatus" "CollectibleOfferStatus" NOT NULL DEFAULT 'NONE',
    "offerRequestId" TEXT,
    "offerIndex" TEXT,
    "offerTxHash" TEXT,
    "offerAmountDrops" TEXT,
    "saleStatus" "CollectibleSaleStatus" NOT NULL DEFAULT 'NONE',
    "saleRequestId" TEXT,
    "saleBuyerAddress" TEXT,
    "saleTxHash" TEXT,
    "soldAt" TIMESTAMPTZ(3),
    "ownerAddress" TEXT,
    "ownerVerifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CollectibleToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_uploaderId_createdAt_idx" ON "MediaAsset"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX "Collectible_sellerId_status_createdAt_idx" ON "Collectible"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Collectible_status_publishedAt_idx" ON "Collectible"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "Collectible_mediaAssetId_idx" ON "Collectible"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_mintRequestId_key" ON "CollectibleToken"("mintRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_mintTxHash_key" ON "CollectibleToken"("mintTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_nftokenId_key" ON "CollectibleToken"("nftokenId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_offerRequestId_key" ON "CollectibleToken"("offerRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_offerIndex_key" ON "CollectibleToken"("offerIndex");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_offerTxHash_key" ON "CollectibleToken"("offerTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_saleRequestId_key" ON "CollectibleToken"("saleRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_saleTxHash_key" ON "CollectibleToken"("saleTxHash");

-- CreateIndex
CREATE INDEX "CollectibleToken_ownerAddress_idx" ON "CollectibleToken"("ownerAddress");

-- CreateIndex
CREATE INDEX "CollectibleToken_mintStatus_idx" ON "CollectibleToken"("mintStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CollectibleToken_collectibleId_edition_key" ON "CollectibleToken"("collectibleId", "edition");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectibleToken" ADD CONSTRAINT "CollectibleToken_collectibleId_fkey" FOREIGN KEY ("collectibleId") REFERENCES "Collectible"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guards the application also enforces (see src/contracts/collectibles.ts).
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_sizeBytes_positive" CHECK ("sizeBytes" > 0);
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_priceDrops_positive" CHECK ("priceDrops" ~ '^[1-9][0-9]{0,17}$');
ALTER TABLE "Collectible" ADD CONSTRAINT "Collectible_editionSize_range" CHECK ("editionSize" BETWEEN 1 AND 100);
ALTER TABLE "CollectibleToken" ADD CONSTRAINT "CollectibleToken_edition_positive" CHECK ("edition" >= 1);
