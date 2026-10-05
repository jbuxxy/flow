-- CreateEnum
CREATE TYPE "PatternDirection" AS ENUM ('CREDIT', 'DEBIT');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "oneOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "patternId" TEXT;

-- CreateTable
CREATE TABLE "RecurringPattern" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "direction" "PatternDirection" NOT NULL,
    "channelKeyword" TEXT NOT NULL,
    "amountMinCents" INTEGER NOT NULL,
    "amountMaxCents" INTEGER NOT NULL,
    "dayOfMonthStart" INTEGER,
    "dayOfMonthEnd" INTEGER,
    "weekdays" INTEGER[],
    "bucketId" TEXT,
    "countsAsIncome" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringPattern_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringPattern_householdId_idx" ON "RecurringPattern"("householdId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "RecurringPattern"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPattern" ADD CONSTRAINT "RecurringPattern_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPattern" ADD CONSTRAINT "RecurringPattern_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
