CREATE TABLE "DebtDueDateReview" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtPaymentId" TEXT NOT NULL,
    "observedDueDate" DATE NOT NULL,
    "statementDate" DATE NOT NULL,
    "expectedDueDate" DATE NOT NULL,
    "accountLast4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtDueDateReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DebtDueDateReview_debtPaymentId_key" ON "DebtDueDateReview"("debtPaymentId");
CREATE INDEX "DebtDueDateReview_householdId_idx" ON "DebtDueDateReview"("householdId");

ALTER TABLE "DebtDueDateReview" ADD CONSTRAINT "DebtDueDateReview_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DebtDueDateReview" ADD CONSTRAINT "DebtDueDateReview_debtPaymentId_fkey" FOREIGN KEY ("debtPaymentId") REFERENCES "DebtPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
