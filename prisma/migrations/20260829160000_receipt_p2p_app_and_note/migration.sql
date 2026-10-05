-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "p2pApp" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "receiptNote" TEXT;
