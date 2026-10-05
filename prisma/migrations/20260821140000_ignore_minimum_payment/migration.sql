-- AlterTable
ALTER TABLE "Debt" DROP COLUMN "minPaymentZeroConfirmed",
ADD COLUMN     "ignoreMinimumPayment" BOOLEAN NOT NULL DEFAULT false;
