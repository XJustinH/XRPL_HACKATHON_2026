-- CreateTable
CREATE TABLE "Follow" (
    "followerId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("followerId","sellerId")
);

-- CreateTable
CREATE TABLE "Wishlist" (
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Wishlist_pkey" PRIMARY KEY ("userId","eventId")
);

-- CreateIndex
CREATE INDEX "Follow_sellerId_idx" ON "Follow"("sellerId");

-- CreateIndex
CREATE INDEX "Wishlist_eventId_idx" ON "Wishlist"("eventId");

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Follow" ADD CONSTRAINT "Follow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wishlist" ADD CONSTRAINT "Wishlist_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written below: Prisma doesn't model CHECK constraints.

ALTER TABLE "Follow" ADD CONSTRAINT "Follow_not_self" CHECK ("followerId" <> "sellerId");

-- Existing data. Until now, Agent C's stores kept follows and saved events as id lists in
-- "User"."settings" ("follows" and "wishlist", XRPL-061/062). Copy them across, keeping only what the
-- app would have accepted: well-formed ids of sellers or organisers other than the user, and events
-- that exist. Repeats collapse into one row. The lists stay in "settings" until the stores move here.
-- The CASE keeps malformed ids away from the ::uuid cast.
INSERT INTO "Follow" ("followerId", "sellerId")
SELECT DISTINCT l."followerId", l."sellerId"
FROM (
  SELECT u."id" AS "followerId",
         CASE WHEN f.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN f.value::uuid END AS "sellerId"
  FROM "User" u
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(u."settings" -> 'follows') = 'array' THEN u."settings" -> 'follows' ELSE '[]'::jsonb END
  ) AS f(value)
) l
JOIN "User" s ON s."id" = l."sellerId" AND s."role" IN ('SELLER', 'ORGANISER')
WHERE l."sellerId" <> l."followerId"
ON CONFLICT DO NOTHING;

INSERT INTO "Wishlist" ("userId", "eventId")
SELECT DISTINCT l."userId", l."eventId"
FROM (
  SELECT u."id" AS "userId",
         CASE WHEN w.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN w.value::uuid END AS "eventId"
  FROM "User" u
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(u."settings" -> 'wishlist') = 'array' THEN u."settings" -> 'wishlist' ELSE '[]'::jsonb END
  ) AS w(value)
) l
JOIN "Event" e ON e."id" = l."eventId"
ON CONFLICT DO NOTHING;
