-- AlterTable
ALTER TABLE "Household" ADD COLUMN     "calendarFeedToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Household_calendarFeedToken_key" ON "Household"("calendarFeedToken");
