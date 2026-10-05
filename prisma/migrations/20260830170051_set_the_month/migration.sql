-- CreateEnum
CREATE TYPE "BudgetPlanStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BUDGET_PLAN_READY';

-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "monthlySurplusTargetCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "monthlyTargetCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BudgetPlan" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "BudgetPlanStatus" NOT NULL DEFAULT 'PENDING',
    "allocation" JSONB NOT NULL,
    "explanation" TEXT NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BudgetPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BudgetPlan_householdId_status_idx" ON "BudgetPlan"("householdId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPlan_householdId_periodKey_key" ON "BudgetPlan"("householdId", "periodKey");

-- AddForeignKey
ALTER TABLE "BudgetPlan" ADD CONSTRAINT "BudgetPlan_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
