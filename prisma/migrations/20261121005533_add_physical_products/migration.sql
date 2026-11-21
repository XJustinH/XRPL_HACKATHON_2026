-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "PhysicalProduct" (
    "id" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "eventId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceDrops" TEXT NOT NULL,
    "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "stock" INTEGER NOT NULL DEFAULT 0,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PhysicalProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhysicalProduct_sellerId_status_createdAt_idx" ON "PhysicalProduct"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "PhysicalProduct_eventId_idx" ON "PhysicalProduct"("eventId");

-- AddForeignKey
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written below: Prisma models neither CHECK constraints nor triggers.

-- Prisma creates list columns as nullable. A product always has a list of images, possibly empty,
-- and a NULL would also slip past the CHECK on the number of images.
ALTER TABLE "PhysicalProduct" ALTER COLUMN "imageUrls" SET NOT NULL;

-- Agent E's constraints (src/features/commerce/README.md), mirroring the commerce contract.
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_priceDrops_positive"
  CHECK ("priceDrops" ~ '^[1-9][0-9]{0,17}$');
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_stock_nonnegative"
  CHECK ("stock" >= 0);
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_images_limit"
  CHECK (cardinality("imageUrls") <= 6);
ALTER TABLE "PhysicalProduct" ADD CONSTRAINT "PhysicalProduct_published_has_date"
  CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL);

-- A product can only be linked to one of its seller's own events (the contract's 403).
CREATE FUNCTION "physical_product_event_same_seller"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."eventId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Event" e
    WHERE e."id" = NEW."eventId" AND e."sellerId" = NEW."sellerId"
  ) THEN
    RAISE EXCEPTION 'PhysicalProduct_event_same_seller: event % does not belong to seller %',
      NEW."eventId", NEW."sellerId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "PhysicalProduct_event_same_seller"
  BEFORE INSERT OR UPDATE OF "eventId", "sellerId" ON "PhysicalProduct"
  FOR EACH ROW EXECUTE FUNCTION "physical_product_event_same_seller"();
