-- CreateEnum
CREATE TYPE "PayoffOrder" AS ENUM ('AVALANCHE', 'SNOWBALL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PayoffMode" AS ENUM ('MINIMUM_ONLY', 'FLAT_EXTRA', 'ROLLING_EXTRA');

-- CreateEnum
CREATE TYPE "PayoffCalendarMode" AS ENUM ('MONTHLY_AVERAGE', 'BIWEEKLY_ACTUAL');

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "payoffAnchorDate" DATE,
ADD COLUMN     "payoffCalendarMode" "PayoffCalendarMode" NOT NULL DEFAULT 'BIWEEKLY_ACTUAL',
ADD COLUMN     "payoffExtraCents" INTEGER NOT NULL DEFAULT 20000,
ADD COLUMN     "payoffMode" "PayoffMode" NOT NULL DEFAULT 'ROLLING_EXTRA',
ADD COLUMN     "payoffOrder" "PayoffOrder" NOT NULL DEFAULT 'AVALANCHE';

-- AlterTable
ALTER TABLE "Income" ADD COLUMN     "lastReceivedDate" DATE;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "incomeId" TEXT;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_incomeId_fkey" FOREIGN KEY ("incomeId") REFERENCES "Income"("id") ON DELETE SET NULL ON UPDATE CASCADE;
