-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- At most one demo household (the read-only public example reachable from /login).
CREATE UNIQUE INDEX "Household_isDemo_key" ON "Household"("isDemo") WHERE "isDemo" = true;
