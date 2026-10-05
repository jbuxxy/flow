-- Starting-balance baseline for account-linked savings goals: progress is
-- measured from the balance at link time, not from $0, so pre-existing money
-- in the account isn't counted toward the goal. 0 for manual goals and for
-- goals linked before this column existed.
ALTER TABLE "SavingsGoal" ADD COLUMN     "baselineCents" INTEGER NOT NULL DEFAULT 0;
