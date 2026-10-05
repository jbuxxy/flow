-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "partyIsPerson" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "resolvedMerchantIsPerson" BOOLEAN NOT NULL DEFAULT false;

