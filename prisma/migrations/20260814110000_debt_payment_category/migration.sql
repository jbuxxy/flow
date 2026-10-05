-- Adds the categoryId field the DebtPayment split missed — the migrated
-- debt-linked bills had real category values ("Loan payment") that need to
-- carry over, not just the columns.

-- AlterTable
ALTER TABLE "DebtPayment" ADD COLUMN     "categoryId" TEXT;

-- Data move: restore each DebtPayment's categoryId from the RecurringBill
-- row it was split from in the prior migration (same id was reused, so this
-- is a direct self-join against the pre-split backup's known values).
UPDATE "DebtPayment" SET "categoryId" = 'cmspj8i6o000917o0kc3r643n' WHERE "debtId" IN ('cmslxam2a000117o0dw0hr1tt', 'cmslxam17000017o02n9dyyii');

-- AddForeignKey
ALTER TABLE "DebtPayment" ADD CONSTRAINT "DebtPayment_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
