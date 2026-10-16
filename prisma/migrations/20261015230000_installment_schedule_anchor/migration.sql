-- Installment plans now project due dates from the schedule the household
-- entered (DebtPayment.scheduleAnchorDate) rather than from each payment's
-- bank posting date.
ALTER TABLE "DebtPayment" ADD COLUMN "scheduleAnchorDate" DATE;

-- A plan with no payment matched yet still carries its setup schedule in
-- nextDueDate (the first payment date, else the purchase date) — that IS the
-- anchor. Plans already under way keep advancing off real payment dates
-- until the household edits their dates.
UPDATE "DebtPayment" dp
SET "scheduleAnchorDate" = dp."nextDueDate"
FROM "Debt" d
WHERE d."id" = dp."debtId"
  AND d."debtType" = 'INSTALLMENT'
  AND dp."lastPaidDate" IS NULL;
