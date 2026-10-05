-- Splits debt-linked RecurringBill rows into their own DebtPayment model.
-- Data-preserving: existing debt-linked bills and their already-matched
-- Transaction links are moved over, not recreated from scratch.

-- CreateTable
CREATE TABLE "DebtPayment" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "cadence" "BillCadence" NOT NULL,
    "toleranceCents" INTEGER,
    "nextDueDate" DATE NOT NULL,
    "lastPaidDate" DATE,
    "dueDateLocked" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DebtAmountReview" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtPaymentId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "observedAmountCents" INTEGER NOT NULL,
    "expectedAmountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtAmountReview_pkey" PRIMARY KEY ("id")
);

-- AlterTable: new nullable debtPaymentId link on Transaction, added before
-- the data move below so it's available to populate.
ALTER TABLE "Transaction" ADD COLUMN "debtPaymentId" TEXT;

-- Data move: carry every debt-linked RecurringBill row over to DebtPayment,
-- reusing the same id so dependent foreign keys map trivially.
INSERT INTO "DebtPayment" (
    "id", "householdId", "debtId", "amountCents", "cadence", "toleranceCents",
    "nextDueDate", "lastPaidDate", "active", "createdAt", "updatedAt"
)
SELECT
    "id", "householdId", "debtId", "amountCents", "cadence", "toleranceCents",
    "nextDueDate", "lastPaidDate", "active", "createdAt", "updatedAt"
FROM "RecurringBill"
WHERE "debtId" IS NOT NULL;

-- Data move: re-point every transaction that was linked to one of those
-- bills over to debtPaymentId instead, clearing the old billId.
UPDATE "Transaction"
SET "debtPaymentId" = "billId", "billId" = NULL
WHERE "billId" IN (SELECT "id" FROM "RecurringBill" WHERE "debtId" IS NOT NULL);

-- Now safe to remove the migrated rows and the debtId column/constraint
-- from RecurringBill (bill-only from here on).
DELETE FROM "RecurringBill" WHERE "debtId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "RecurringBill" DROP CONSTRAINT "RecurringBill_debtId_fkey";

-- AlterTable
ALTER TABLE "RecurringBill" DROP COLUMN "debtId",
ADD COLUMN     "dueDateLocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "termsConfirmed" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "DebtPayment_debtId_key" ON "DebtPayment"("debtId");

-- CreateIndex
CREATE INDEX "DebtPayment_householdId_idx" ON "DebtPayment"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtAmountReview_transactionId_key" ON "DebtAmountReview"("transactionId");

-- CreateIndex
CREATE INDEX "DebtAmountReview_householdId_idx" ON "DebtAmountReview"("householdId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_debtPaymentId_fkey" FOREIGN KEY ("debtPaymentId") REFERENCES "DebtPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtAmountReview" ADD CONSTRAINT "DebtAmountReview_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtAmountReview" ADD CONSTRAINT "DebtAmountReview_debtPaymentId_fkey" FOREIGN KEY ("debtPaymentId") REFERENCES "DebtPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtAmountReview" ADD CONSTRAINT "DebtAmountReview_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
