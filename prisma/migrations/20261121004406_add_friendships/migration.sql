-- CreateEnum
CREATE TYPE "FriendStatus" AS ENUM ('PENDING', 'ACCEPTED');

-- CreateTable
CREATE TABLE "FriendConnection" (
    "id" UUID NOT NULL,
    "userLowId" UUID NOT NULL,
    "userHighId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "status" "FriendStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMPTZ(3),

    CONSTRAINT "FriendConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlock" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateIndex
CREATE INDEX "FriendConnection_userHighId_idx" ON "FriendConnection"("userHighId");

-- CreateIndex
CREATE UNIQUE INDEX "FriendConnection_userLowId_userHighId_key" ON "FriendConnection"("userLowId", "userHighId");

-- CreateIndex
CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");

-- AddForeignKey
ALTER TABLE "FriendConnection" ADD CONSTRAINT "FriendConnection_userLowId_fkey" FOREIGN KEY ("userLowId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendConnection" ADD CONSTRAINT "FriendConnection_userHighId_fkey" FOREIGN KEY ("userHighId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written below: Prisma doesn't model CHECK constraints.

-- One row per pair, lower ID first, so A→B and B→A can't both exist, and nobody befriends themselves.
-- Postgres orders UUIDs as their lowercase text sorts, which is how the friend service orders a pair.
ALTER TABLE "FriendConnection" ADD CONSTRAINT "FriendConnection_pair_order"
  CHECK ("userLowId" < "userHighId");

-- The request came from one of the two people.
ALTER TABLE "FriendConnection" ADD CONSTRAINT "FriendConnection_requester_in_pair"
  CHECK ("requestedById" IN ("userLowId", "userHighId"));

-- Accepted exactly when answered: declining or removing deletes the row instead.
ALTER TABLE "FriendConnection" ADD CONSTRAINT "FriendConnection_responded_when_accepted"
  CHECK (("status" = 'ACCEPTED') = ("respondedAt" IS NOT NULL));

ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_not_self"
  CHECK ("blockerId" <> "blockedId");
