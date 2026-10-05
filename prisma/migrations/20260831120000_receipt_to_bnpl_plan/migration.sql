-- AlterEnum
ALTER TYPE "ReceiptMatchState" ADD VALUE 'MATCHED_TO_PLAN';

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "receiptItems" JSONB,
ADD COLUMN     "receiptTotalCents" INTEGER;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "debtId" TEXT;

-- CreateIndex
CREATE INDEX "Receipt_debtId_idx" ON "Receipt"("debtId");

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
