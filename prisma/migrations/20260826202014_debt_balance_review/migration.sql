-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'DEBT_BALANCE_PAID_OFF_REVIEW';

-- CreateTable
CREATE TABLE "DebtBalanceReview" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtBalanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DebtBalanceReview_debtId_key" ON "DebtBalanceReview"("debtId");

-- CreateIndex
CREATE INDEX "DebtBalanceReview_householdId_idx" ON "DebtBalanceReview"("householdId");

-- AddForeignKey
ALTER TABLE "DebtBalanceReview" ADD CONSTRAINT "DebtBalanceReview_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtBalanceReview" ADD CONSTRAINT "DebtBalanceReview_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
