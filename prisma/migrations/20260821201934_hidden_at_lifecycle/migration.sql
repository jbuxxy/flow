-- AlterTable
ALTER TABLE "Account" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- Preserve currently-hidden debts' state across the boolean->timestamp
-- rename — best-guess "now" since the old column never recorded when a
-- debt was hidden, only that it was.
UPDATE "Debt" SET "hiddenAt" = now() WHERE "hiddenWhilePaidOff" = true;

ALTER TABLE "Debt" DROP COLUMN "hiddenWhilePaidOff";
