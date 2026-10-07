-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "semiMonthlyDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- Backfill existing semi-monthly incomes with a pay-day pair guessed from
-- their next pay date — same rule as semiMonthlyDaysOrDefault (income-calc.ts).
UPDATE "Income" i
SET "semiMonthlyDays" = CASE
    WHEN d.day IN (1, 15, 16) THEN ARRAY[1, 15]
    WHEN d.day >= 28 THEN ARRAY[15, 31]
    WHEN d.day < 15 THEN ARRAY[d.day, d.day + 15]
    ELSE ARRAY[d.day - 15, d.day]
  END
FROM (SELECT id, EXTRACT(DAY FROM "nextPayDate")::INTEGER AS day FROM "Income") d
WHERE d.id = i.id AND i."cadence" = 'SEMI_MONTHLY' AND i."nextPayDate" IS NOT NULL;
