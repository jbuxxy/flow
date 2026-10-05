-- DropIndex
DROP INDEX "BillCategory_householdId_name_key";

-- AlterTable
ALTER TABLE "BillCategory" ADD COLUMN     "bucketId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BillCategory_bucketId_name_key" ON "BillCategory"("bucketId", "name");

-- AddForeignKey
ALTER TABLE "BillCategory" ADD CONSTRAINT "BillCategory_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
