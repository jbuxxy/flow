-- Amount-bounded merchant rules: one merchant can route to different buckets
-- by transaction size (e.g. "Maverik under $15 -> Dining, otherwise -> Fuel").
-- NULL/NULL bounds = the merchant's base rule (learning path); bounds set =
-- a user-authored override checked first, narrowest window winning.

-- AlterTable
ALTER TABLE "MerchantRule"
  ADD COLUMN "amountMinCents" INTEGER,
  ADD COLUMN "amountMaxCents" INTEGER,
  ADD COLUMN "managedByUser" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex: a merchant can now carry several rows (one base + bounded
-- overrides), so the plain unique-per-merchant constraint is dropped.
-- Base-rule uniqueness (NULL/NULL bounds) is enforced in upsertMerchantRule
-- instead — kept out of the DB so Prisma's schema-vs-datasource diff, which
-- can't express a partial unique index, never proposes dropping it.
DROP INDEX "MerchantRule_householdId_merchant_key";

-- CreateIndex: the lookup path is now "all rules for this merchant".
CREATE INDEX "MerchantRule_householdId_merchant_idx"
  ON "MerchantRule"("householdId", "merchant");
