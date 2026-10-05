-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'BUCKET_TRANSACTION';
ALTER TYPE "NotificationType" ADD VALUE 'NEEDS_BUCKET';
ALTER TYPE "NotificationType" ADD VALUE 'RECEIPT_NEEDS_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE 'NEEDS_LABEL_P2P';

-- AlterTable
ALTER TABLE "Bucket" ADD COLUMN     "transactionAlertEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BucketTransactionAlert" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BucketTransactionAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NudgeAlert" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "anchor" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NudgeAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BucketTransactionAlert_transactionId_key" ON "BucketTransactionAlert"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "NudgeAlert_householdId_kind_key" ON "NudgeAlert"("householdId", "kind");

-- AddForeignKey
ALTER TABLE "BucketTransactionAlert" ADD CONSTRAINT "BucketTransactionAlert_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NudgeAlert" ADD CONSTRAINT "NudgeAlert_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
