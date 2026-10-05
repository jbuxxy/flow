-- CreateTable
CREATE TABLE "MonthlyInsight" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyInsight_householdId_periodKey_key" ON "MonthlyInsight"("householdId", "periodKey");

-- AddForeignKey
ALTER TABLE "MonthlyInsight" ADD CONSTRAINT "MonthlyInsight_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
