-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BUCKET_TOPPED_UP';

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "autoApplyAdHocIncomeToBuckets" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BucketAdHocTopUp" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "sourceTransactionId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BucketAdHocTopUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BucketAdHocTopUp_householdId_periodKey_idx" ON "BucketAdHocTopUp"("householdId", "periodKey");

-- CreateIndex
CREATE INDEX "BucketAdHocTopUp_bucketId_periodKey_idx" ON "BucketAdHocTopUp"("bucketId", "periodKey");

-- CreateIndex
CREATE INDEX "BucketAdHocTopUp_sourceTransactionId_idx" ON "BucketAdHocTopUp"("sourceTransactionId");

-- AddForeignKey
ALTER TABLE "BucketAdHocTopUp" ADD CONSTRAINT "BucketAdHocTopUp_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketAdHocTopUp" ADD CONSTRAINT "BucketAdHocTopUp_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketAdHocTopUp" ADD CONSTRAINT "BucketAdHocTopUp_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
