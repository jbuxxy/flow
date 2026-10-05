-- CreateEnum
CREATE TYPE "IncomeCalcMethod" AS ENUM ('MONTHLY_AVERAGE', 'BIWEEKLY_CONSERVATIVE');

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "incomeCalcMethod" "IncomeCalcMethod" NOT NULL DEFAULT 'MONTHLY_AVERAGE',
ADD COLUMN     "includeP2PInIncomeCalc" BOOLEAN NOT NULL DEFAULT false;
