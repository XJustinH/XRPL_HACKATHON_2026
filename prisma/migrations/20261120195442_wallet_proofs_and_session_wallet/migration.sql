-- AlterEnum
ALTER TYPE "SessionMethod" ADD VALUE 'WALLET';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "walletAddress" TEXT,
ADD COLUMN     "walletVerifiedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "WalletProof" (
    "id" UUID NOT NULL,
    "signRequestId" TEXT NOT NULL,
    "network" "XrplNetwork" NOT NULL DEFAULT 'TESTNET',
    "browserTokenHash" TEXT NOT NULL,
    "requestedAddress" TEXT,
    "sessionId" UUID,
    "signerAddress" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WalletProof_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletProof_signRequestId_key" ON "WalletProof"("signRequestId");

-- CreateIndex
CREATE INDEX "WalletProof_expiresAt_idx" ON "WalletProof"("expiresAt");

-- AddForeignKey
ALTER TABLE "WalletProof" ADD CONSTRAINT "WalletProof_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints (hand-written).
-- ---------------------------------------------------------------------------

-- A session either has a proven wallet (with the time it was proven) or neither.
ALTER TABLE "Session" ADD CONSTRAINT "Session_wallet_pair"
  CHECK (("walletAddress" IS NULL) = ("walletVerifiedAt" IS NULL));

ALTER TABLE "WalletProof" ADD CONSTRAINT "WalletProof_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");

-- Only a SHA-256 hex digest of the browser binding token is stored, never the token.
ALTER TABLE "WalletProof" ADD CONSTRAINT "WalletProof_browser_token_sha256"
  CHECK ("browserTokenHash" ~ '^[0-9a-f]{64}$');

-- A consumed proof records who signed it.
ALTER TABLE "WalletProof" ADD CONSTRAINT "WalletProof_consumed_has_signer"
  CHECK ("consumedAt" IS NULL OR "signerAddress" IS NOT NULL);
