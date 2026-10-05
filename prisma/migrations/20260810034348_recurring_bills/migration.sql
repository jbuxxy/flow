-- CreateEnum
CREATE TYPE "BillCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "billId" TEXT;

-- CreateTable
CREATE TABLE "RecurringBill" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "merchant" TEXT,
    "amountCents" INTEGER NOT NULL,
    "cadence" "BillCadence" NOT NULL,
    "bucketId" TEXT,
    "nextDueDate" DATE NOT NULL,
    "lastPaidDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillsInsight" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillsInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringBill_householdId_idx" ON "RecurringBill"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "BillsInsight_householdId_dateKey_key" ON "BillsInsight"("householdId", "dateKey");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillsInsight" ADD CONSTRAINT "BillsInsight_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
