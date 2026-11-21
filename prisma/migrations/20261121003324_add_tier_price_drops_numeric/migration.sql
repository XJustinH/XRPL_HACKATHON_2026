-- AlterTable
ALTER TABLE "TicketTier" ADD COLUMN     "priceDropsNumeric" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "TicketTier_priceDropsNumeric_idx" ON "TicketTier"("priceDropsNumeric");

-- Hand-written below: Prisma models neither triggers nor CHECK constraints.
-- "priceDropsNumeric" is "priceDrops" as a number, so price filters and sorting compare numbers,
-- not strings ("9" > "10"). The database keeps the two equal; the app never sets the number.

CREATE FUNCTION "ticket_tier_price_drops_numeric"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Same pattern as CHECK "TicketTier_priceDrops_format" (at most 18 digits, so it fits a bigint).
  -- A malformed price is left for that CHECK to reject with its own name, not a cast error here.
  NEW."priceDropsNumeric" := CASE
    WHEN NEW."priceDrops" ~ '^(0|[1-9][0-9]{0,17})$' THEN NEW."priceDrops"::bigint
    ELSE 0
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TicketTier_price_drops_numeric"
  BEFORE INSERT OR UPDATE ON "TicketTier"
  FOR EACH ROW EXECUTE FUNCTION "ticket_tier_price_drops_numeric"();

-- Existing tiers.
UPDATE "TicketTier" SET "priceDropsNumeric" = "priceDrops"::bigint;

-- Holds even if the trigger is bypassed (e.g. disabled for a bulk load).
ALTER TABLE "TicketTier" ADD CONSTRAINT "TicketTier_priceDropsNumeric_matches"
  CHECK (CASE
    WHEN "priceDrops" ~ '^(0|[1-9][0-9]{0,17})$' THEN "priceDropsNumeric" = "priceDrops"::bigint
    ELSE true
  END);
