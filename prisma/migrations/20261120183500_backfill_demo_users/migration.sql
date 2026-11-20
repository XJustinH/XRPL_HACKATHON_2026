-- Backfill User.isDemo for accounts the XRPL-008 demo seed already labelled with
-- settings.demo = true before the column existed. New seeds set isDemo directly.
UPDATE "User" SET "isDemo" = true WHERE "settings" @> '{"demo": true}'::jsonb AND "isDemo" = false;
