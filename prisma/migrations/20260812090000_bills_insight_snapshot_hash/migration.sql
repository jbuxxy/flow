-- DropIndex
DROP INDEX "BillsInsight_householdId_dateKey_key";

-- AlterTable
ALTER TABLE "BillsInsight" ADD COLUMN "snapshotHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BillsInsight" ALTER COLUMN "snapshotHash" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "BillsInsight_householdId_dateKey_snapshotHash_key" ON "BillsInsight"("householdId", "dateKey", "snapshotHash");
