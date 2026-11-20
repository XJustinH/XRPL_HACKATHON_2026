-- CreateTable
CREATE TABLE "Review" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "checkInRecordId" UUID,
    "hiddenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_checkInRecordId_key" ON "Review"("checkInRecordId");

-- CreateIndex
CREATE INDEX "Review_eventId_createdAt_idx" ON "Review"("eventId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_eventId_authorId_key" ON "Review"("eventId", "authorId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_checkInRecordId_fkey" FOREIGN KEY ("checkInRecordId") REFERENCES "CheckInRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Integrity rules (hand-written). Prisma does not model CHECKs or triggers, so
-- future generated migrations leave these in place.
-- ---------------------------------------------------------------------------

ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range"
  CHECK ("rating" BETWEEN 1 AND 5);

ALTER TABLE "Review" ADD CONSTRAINT "Review_body_length"
  CHECK (char_length("body") <= 2000);

-- A review's check-in must be an admission to the SAME event. (A composite foreign key would do
-- this, but Prisma can't model one that mixes an optional and a required column.)
CREATE FUNCTION "review_checkin_same_event"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."checkInRecordId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "CheckInRecord" c
    WHERE c."id" = NEW."checkInRecordId" AND c."eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'Review_checkin_same_event: check-in % is not an admission to event %',
      NEW."checkInRecordId", NEW."eventId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Review_checkin_same_event"
  BEFORE INSERT OR UPDATE OF "checkInRecordId", "eventId" ON "Review"
  FOR EACH ROW EXECUTE FUNCTION "review_checkin_same_event"();
