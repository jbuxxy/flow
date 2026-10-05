-- AlterTable
ALTER TABLE "Debt" ADD COLUMN "freedMinimumCents" INTEGER;

-- Backfill: every already-paid-off debt that still shows a real minimum.
UPDATE "Debt" SET "freedMinimumCents" = "minPaymentCents" WHERE "balanceCents" <= 0 AND "minPaymentCents" > 0;
