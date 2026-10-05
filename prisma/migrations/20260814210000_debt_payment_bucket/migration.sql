-- AlterTable
ALTER TABLE "DebtPayment" ADD COLUMN     "bucketId" TEXT;

-- CreateIndex
CREATE INDEX "DebtPayment_bucketId_idx" ON "DebtPayment"("bucketId");

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
