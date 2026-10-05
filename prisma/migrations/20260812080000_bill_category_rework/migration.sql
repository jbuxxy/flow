-- Preserve each bill's current category as plain text before dropping the
-- fixed enum, so a follow-up data script can create real BillCategory rows
-- per household and backfill categoryId from it. Dropped again at the end
-- of that script once the backfill is done — never shipped in the schema.
ALTER TABLE "RecurringBill" ADD COLUMN "categoryLabel" TEXT;

UPDATE "RecurringBill" SET "categoryLabel" = CASE "category"
  WHEN 'HOUSING' THEN 'Mortgage/Rent'
  WHEN 'UTILITIES' THEN 'Utilities'
  WHEN 'INSURANCE' THEN 'Insurance'
  WHEN 'LOAN' THEN 'Loan payment'
  WHEN 'SUBSCRIPTION' THEN 'Subscription'
  ELSE 'Other'
END;

-- DropForeignKey
ALTER TABLE "RecurringBill" DROP CONSTRAINT "RecurringBill_subcategoryId_fkey";

-- AlterTable
ALTER TABLE "RecurringBill" DROP COLUMN "category",
DROP COLUMN "subcategoryId";

-- DropTable
DROP TABLE "BillSubcategory";

-- DropEnum
DROP TYPE "BillCategory";

-- CreateTable
CREATE TABLE "BillCategory" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillCategory_householdId_idx" ON "BillCategory"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "BillCategory_householdId_name_key" ON "BillCategory"("householdId", "name");

-- AddForeignKey
ALTER TABLE "BillCategory" ADD CONSTRAINT "BillCategory_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "RecurringBill" ADD COLUMN "categoryId" TEXT;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
