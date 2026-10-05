-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "accountedForByTransactionId" TEXT;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountedForByTransactionId_fkey" FOREIGN KEY ("accountedForByTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
