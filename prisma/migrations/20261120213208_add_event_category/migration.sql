-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "Event_status_category_startsAt_idx" ON "Event"("status", "category", "startsAt");

-- ---------------------------------------------------------------------------
-- Integrity constraint (hand-written).
-- ---------------------------------------------------------------------------

-- "No category" is NULL, never an empty or padded string, so filters see one value per category.
-- The list of allowed categories lives in the events contract, not here.
ALTER TABLE "Event" ADD CONSTRAINT "Event_category_format"
  CHECK ("category" IS NULL OR (char_length("category") BETWEEN 1 AND 40 AND "category" = btrim("category")));
