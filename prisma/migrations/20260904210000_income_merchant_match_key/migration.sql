-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "merchant" TEXT;

-- Backfill: every existing Income's `name` has been the de facto match key
-- until now, so copy it forward as `merchant` to preserve current matching
-- behavior. Renaming `name` after this never touches `merchant` again.
UPDATE "Income" SET "merchant" = "name" WHERE "merchant" IS NULL;
