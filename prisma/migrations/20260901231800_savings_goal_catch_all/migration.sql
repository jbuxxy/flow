-- AlterTable
ALTER TABLE "SavingsGoal" ADD COLUMN     "isCatchAll" BOOLEAN NOT NULL DEFAULT false;

-- At most one "General Savings" catch-all goal per household (where budgeted
-- surplus routed to savings lands once every dated goal is on pace).
CREATE UNIQUE INDEX "SavingsGoal_householdId_isCatchAll_key" ON "SavingsGoal"("householdId", "isCatchAll") WHERE "isCatchAll" = true;
