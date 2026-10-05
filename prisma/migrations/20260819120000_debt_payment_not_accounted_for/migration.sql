-- AlterTable
ALTER TABLE "DebtPayment" DROP COLUMN "excludeFromBucketTotal";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "notAccountedFor" BOOLEAN NOT NULL DEFAULT false;
