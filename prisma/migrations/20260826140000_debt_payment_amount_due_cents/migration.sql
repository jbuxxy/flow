-- AlterTable
ALTER TABLE "DebtPayment" ADD COLUMN     "amountDueCents" INTEGER;

-- Backfill: every existing tracker starts "caught up" — the rolling total
-- owed equals its regular minimum, with no carried-over backlog assumed.
-- matchDebtPayments (src/lib/debt-payments.ts) takes over from here on the
-- next sync.
UPDATE "DebtPayment" SET "amountDueCents" = "amountCents";

ALTER TABLE "DebtPayment" ALTER COLUMN "amountDueCents" SET NOT NULL;
