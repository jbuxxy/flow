
-- CreateEnum
CREATE TYPE "HouseholdGoalPosture" AS ENUM ('DEBT_PAYDOWN', 'SAVINGS_FOCUSED', 'BALANCED');

-- CreateEnum
CREATE TYPE "OnboardingStep" AS ENUM ('PROFILE', 'CONNECT', 'REPORT', 'BUCKETS', 'DONE');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('STARTUP', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('OPEN', 'ARCHIVED');

-- DropForeignKey
ALTER TABLE "MonthlyInsight" DROP CONSTRAINT "MonthlyInsight_householdId_fkey";

-- AlterTable
ALTER TABLE "Bucket" ADD COLUMN     "aiInstructions" TEXT;

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "adultsCount" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "goalPosture" "HouseholdGoalPosture" NOT NULL DEFAULT 'BALANCED',
ADD COLUMN     "kidsCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStep" "OnboardingStep" NOT NULL DEFAULT 'PROFILE';

-- DropTable
DROP TABLE "MonthlyInsight";

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'OPEN',
    "findings" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "pdfBytes" BYTEA,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_householdId_type_status_idx" ON "Report"("householdId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Report_householdId_periodKey_key" ON "Report"("householdId", "periodKey");

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: every household that already exists as of this migration
-- predates the setup wizard entirely (it was built and lived its whole life
-- without one) — mark it as already onboarded so it isn't redirected into
-- the wizard on next login. Only a household created after this migration
-- (onboardingCompletedAt still null, the column default) ever sees it.
UPDATE "Household" SET "onboardingCompletedAt" = NOW(), "onboardingStep" = 'DONE';

