-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "extraLegReceiptId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_extraLegReceiptId_idx" ON "Transaction"("extraLegReceiptId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_extraLegReceiptId_fkey" FOREIGN KEY ("extraLegReceiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
