-- AlterTable
ALTER TABLE "RecurringPattern" ADD COLUMN     "billId" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "reimbursesTransactionId" TEXT;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_reimbursesTransactionId_fkey" FOREIGN KEY ("reimbursesTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPattern" ADD CONSTRAINT "RecurringPattern_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
