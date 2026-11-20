-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'SELLER', 'ORGANISER');

-- CreateEnum
CREATE TYPE "XrplNetwork" AS ENUM ('TESTNET', 'DEVNET');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "MintStatus" AS ENUM ('PENDING', 'SUBMITTED', 'MINTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('UNSYNCED', 'SYNCED', 'STALE', 'ERROR');

-- CreateEnum
CREATE TYPE "OfferKind" AS ENUM ('PRIMARY', 'RESALE', 'PRIVATE', 'GIFT');

-- CreateEnum
CREATE TYPE "OfferState" AS ENUM ('PENDING_SIGNATURE', 'ACTIVE', 'ACCEPTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'STALE');

-- CreateEnum
CREATE TYPE "LedgerTxStatus" AS ENUM ('PENDING', 'VALIDATED_SUCCESS', 'VALIDATED_FAILURE', 'DROPPED');

-- CreateEnum
CREATE TYPE "LedgerTxType" AS ENUM ('NFTokenMint', 'NFTokenCreateOffer', 'NFTokenAcceptOffer', 'NFTokenCancelOffer', 'Payment');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "displayName" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "onboardedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLink" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET',
    "address" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "verificationProvider" TEXT,
    "verificationRef" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WalletLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3),
    "venue" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'DRAFT',
    "artworkUrl" TEXT,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketTier" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceDrops" TEXT NOT NULL,
    "totalSupply" INTEGER NOT NULL,
    "mintedQuantity" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TicketTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketNFT" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "tierId" UUID NOT NULL,
    "serial" INTEGER NOT NULL,
    "nftokenId" TEXT,
    "issuerAddress" TEXT,
    "metadataUri" TEXT,
    "mintStatus" "MintStatus" NOT NULL DEFAULT 'PENDING',
    "mintTxHash" TEXT,
    "mintedAt" TIMESTAMPTZ(3),
    "primarySoldAt" TIMESTAMPTZ(3),
    "primarySaleTxHash" TEXT,
    "cachedOwnerAddress" TEXT,
    "ownerSyncStatus" "SyncStatus" NOT NULL DEFAULT 'UNSYNCED',
    "ownerSyncedAt" TIMESTAMPTZ(3),
    "ownerSyncLedgerIndex" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TicketNFT_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NFTOffer" (
    "id" UUID NOT NULL,
    "ticketId" UUID,
    "nftokenId" TEXT NOT NULL,
    "offerIndex" TEXT,
    "kind" "OfferKind" NOT NULL,
    "state" "OfferState" NOT NULL DEFAULT 'PENDING_SIGNATURE',
    "ownerAddress" TEXT NOT NULL,
    "destinationAddress" TEXT,
    "amountDrops" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createTxHash" TEXT,
    "acceptTxHash" TEXT,
    "cancelTxHash" TEXT,
    "acceptedByAddress" TEXT,
    "createdByUserId" UUID,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NFTOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "hash" TEXT,
    "type" "LedgerTxType" NOT NULL,
    "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET',
    "account" TEXT,
    "status" "LedgerTxStatus" NOT NULL DEFAULT 'PENDING',
    "resultCode" TEXT,
    "ledgerIndex" INTEGER,
    "validatedAt" TIMESTAMPTZ(3),
    "appliedAt" TIMESTAMPTZ(3),
    "signRequestRef" TEXT,
    "relatedTicketId" UUID,
    "relatedOfferId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInChallenge" (
    "id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "ticketId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "proofReference" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckInChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInRecord" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "organiserId" UUID NOT NULL,
    "challengeId" UUID,
    "walletAddress" TEXT NOT NULL,
    "scannedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedLedgerIndex" INTEGER,

    CONSTRAINT "CheckInRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WalletLink_userId_idx" ON "WalletLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLink_network_address_key" ON "WalletLink"("network", "address");

-- CreateIndex
CREATE INDEX "Event_status_startsAt_idx" ON "Event"("status", "startsAt");

-- CreateIndex
CREATE INDEX "Event_sellerId_idx" ON "Event"("sellerId");

-- CreateIndex
CREATE INDEX "TicketTier_eventId_idx" ON "TicketTier"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketTier_eventId_name_key" ON "TicketTier"("eventId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TicketNFT_nftokenId_key" ON "TicketNFT"("nftokenId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketNFT_mintTxHash_key" ON "TicketNFT"("mintTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "TicketNFT_primarySaleTxHash_key" ON "TicketNFT"("primarySaleTxHash");

-- CreateIndex
CREATE INDEX "TicketNFT_eventId_idx" ON "TicketNFT"("eventId");

-- CreateIndex
CREATE INDEX "TicketNFT_cachedOwnerAddress_idx" ON "TicketNFT"("cachedOwnerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "TicketNFT_tierId_serial_key" ON "TicketNFT"("tierId", "serial");

-- CreateIndex
CREATE UNIQUE INDEX "NFTOffer_offerIndex_key" ON "NFTOffer"("offerIndex");

-- CreateIndex
CREATE UNIQUE INDEX "NFTOffer_createTxHash_key" ON "NFTOffer"("createTxHash");

-- CreateIndex
CREATE INDEX "NFTOffer_nftokenId_idx" ON "NFTOffer"("nftokenId");

-- CreateIndex
CREATE INDEX "NFTOffer_ticketId_state_idx" ON "NFTOffer"("ticketId", "state");

-- CreateIndex
CREATE INDEX "NFTOffer_kind_state_idx" ON "NFTOffer"("kind", "state");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_hash_key" ON "LedgerTransaction"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerTransaction_signRequestRef_key" ON "LedgerTransaction"("signRequestRef");

-- CreateIndex
CREATE INDEX "LedgerTransaction_status_idx" ON "LedgerTransaction"("status");

-- CreateIndex
CREATE INDEX "LedgerTransaction_relatedTicketId_idx" ON "LedgerTransaction"("relatedTicketId");

-- CreateIndex
CREATE INDEX "LedgerTransaction_relatedOfferId_idx" ON "LedgerTransaction"("relatedOfferId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInChallenge_nonce_key" ON "CheckInChallenge"("nonce");

-- CreateIndex
CREATE INDEX "CheckInChallenge_ticketId_idx" ON "CheckInChallenge"("ticketId");

-- CreateIndex
CREATE INDEX "CheckInChallenge_eventId_expiresAt_idx" ON "CheckInChallenge"("eventId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInRecord_challengeId_key" ON "CheckInRecord"("challengeId");

-- CreateIndex
CREATE INDEX "CheckInRecord_eventId_scannedAt_idx" ON "CheckInRecord"("eventId", "scannedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckInRecord_ticketId_eventId_key" ON "CheckInRecord"("ticketId", "eventId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_route_key_key" ON "IdempotencyRecord"("scope", "route", "key");

-- AddForeignKey
ALTER TABLE "WalletLink" ADD CONSTRAINT "WalletLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNFT" ADD CONSTRAINT "TicketNFT_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketNFT" ADD CONSTRAINT "TicketNFT_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "TicketTier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFTOffer" ADD CONSTRAINT "NFTOffer_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "TicketNFT"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFTOffer" ADD CONSTRAINT "NFTOffer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInChallenge" ADD CONSTRAINT "CheckInChallenge_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "TicketNFT"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInChallenge" ADD CONSTRAINT "CheckInChallenge_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord" ADD CONSTRAINT "CheckInRecord_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "TicketNFT"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord" ADD CONSTRAINT "CheckInRecord_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord" ADD CONSTRAINT "CheckInRecord_organiserId_fkey" FOREIGN KEY ("organiserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord" ADD CONSTRAINT "CheckInRecord_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "CheckInChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints not expressible in Prisma schema (hand-written).
-- ---------------------------------------------------------------------------

-- XRP amounts: non-negative integer drops as decimal strings, max 1e17 drops (total XRP supply).
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_priceDrops_format"
  CHECK ("priceDrops" ~ '^(0|[1-9][0-9]{0,17})$');
ALTER TABLE "NFTOffer" ADD CONSTRAINT "NFTOffer_amountDrops_format"
  CHECK ("amountDrops" ~ '^(0|[1-9][0-9]{0,17})$');

-- Supply bounds: primary inventory can never be over-minted.
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_supply_bounds"
  CHECK ("totalSupply" > 0 AND "mintedQuantity" >= 0 AND "mintedQuantity" <= "totalSupply");

ALTER TABLE "TicketNFT" ADD CONSTRAINT "TicketNFT_serial_positive" CHECK ("serial" >= 1);

-- A MINTED ticket must carry its ledger identity.
ALTER TABLE "TicketNFT" ADD CONSTRAINT "TicketNFT_minted_has_identity"
  CHECK ("mintStatus" <> 'MINTED' OR ("nftokenId" IS NOT NULL AND "mintTxHash" IS NOT NULL AND "mintedAt" IS NOT NULL));

-- Gifts are zero-price and recipient-restricted; private offers are recipient-restricted.
ALTER TABLE "NFTOffer" ADD CONSTRAINT "NFTOffer_gift_rules"
  CHECK ("kind" <> 'GIFT' OR ("amountDrops" = '0' AND "destinationAddress" IS NOT NULL));
ALTER TABLE "NFTOffer" ADD CONSTRAINT "NFTOffer_private_rules"
  CHECK ("kind" <> 'PRIVATE' OR "destinationAddress" IS NOT NULL);

-- Check-in challenges must expire after creation.
ALTER TABLE "CheckInChallenge" ADD CONSTRAINT "CheckInChallenge_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");
