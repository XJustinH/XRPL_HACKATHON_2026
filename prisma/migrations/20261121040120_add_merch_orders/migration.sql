-- CreateEnum
CREATE TYPE "MerchOrderStatus" AS ENUM ('NEW', 'PROCESSING', 'SHIPPED', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MerchOrder" (
    "id" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "status" "MerchOrderStatus" NOT NULL DEFAULT 'NEW',
    "totalDrops" TEXT NOT NULL,
    "shippingName" TEXT NOT NULL,
    "shippingAddress" TEXT NOT NULL,
    "restockedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MerchOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchOrderItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "productName" TEXT NOT NULL,
    "unitPriceDrops" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "MerchOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchOrder_buyerId_createdAt_idx" ON "MerchOrder"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "MerchOrder_sellerId_status_createdAt_idx" ON "MerchOrder"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MerchOrderItem_productId_idx" ON "MerchOrderItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchOrderItem_orderId_productId_key" ON "MerchOrderItem"("orderId", "productId");

-- AddForeignKey
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MerchOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "PhysicalProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written below: Prisma does not model CHECK constraints.
-- They mirror the commerce contract (src/contracts/commerce.ts), so the database is the last guard.
ALTER TABLE "MerchOrder" ADD CONSTRAINT "MerchOrder_totalDrops_positive"
  CHECK ("totalDrops" ~ '^[1-9][0-9]{0,17}$');
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_unitPriceDrops_positive"
  CHECK ("unitPriceDrops" ~ '^[1-9][0-9]{0,17}$');
ALTER TABLE "MerchOrderItem" ADD CONSTRAINT "MerchOrderItem_quantity_positive"
  CHECK ("quantity" >= 1);
