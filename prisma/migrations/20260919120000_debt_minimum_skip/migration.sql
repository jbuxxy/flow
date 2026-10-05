-- CreateTable
CREATE TABLE "DebtMinimumSkip" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "skippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtMinimumSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DebtMinimumSkip_householdId_idx" ON "DebtMinimumSkip"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtMinimumSkip_debtId_dueDate_key" ON "DebtMinimumSkip"("debtId", "dueDate");

-- AddForeignKey
ALTER TABLE "DebtMinimumSkip" ADD CONSTRAINT "DebtMinimumSkip_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtMinimumSkip" ADD CONSTRAINT "DebtMinimumSkip_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

