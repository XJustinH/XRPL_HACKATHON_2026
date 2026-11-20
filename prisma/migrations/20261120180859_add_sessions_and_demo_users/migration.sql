-- CreateEnum
CREATE TYPE "SessionMethod" AS ENUM ('ONBOARDING', 'DEMO_PERSONA');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" "SessionMethod" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "User_isDemo_idx" ON "User"("isDemo");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity constraints (hand-written).
-- ---------------------------------------------------------------------------

-- Only a SHA-256 hex digest is ever stored, never the raw cookie token.
ALTER TABLE "Session" ADD CONSTRAINT "Session_tokenHash_sha256"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "Session" ADD CONSTRAINT "Session_expiry_after_creation"
  CHECK ("expiresAt" > "createdAt");
