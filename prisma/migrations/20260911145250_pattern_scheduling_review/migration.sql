-- AlterTable
ALTER TABLE "RecurringPattern" ADD COLUMN     "cadence" "BillCadence",
ADD COLUMN     "counterpartyName" TEXT,
ADD COLUMN     "dueDateLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastPaidDate" DATE,
ADD COLUMN     "nextDueDate" DATE,
ADD COLUMN     "noteKeywords" TEXT[],
ADD COLUMN     "toleranceCents" INTEGER;

-- CreateTable
CREATE TABLE "PatternPaymentReview" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "patternId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "observedAmountCents" INTEGER NOT NULL,
    "expectedAmountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatternPaymentReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatternPaymentReview_transactionId_key" ON "PatternPaymentReview"("transactionId");

-- CreateIndex
CREATE INDEX "PatternPaymentReview_householdId_idx" ON "PatternPaymentReview"("householdId");

-- AddForeignKey
ALTER TABLE "PatternPaymentReview" ADD CONSTRAINT "PatternPaymentReview_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternPaymentReview" ADD CONSTRAINT "PatternPaymentReview_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "RecurringPattern"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatternPaymentReview" ADD CONSTRAINT "PatternPaymentReview_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
