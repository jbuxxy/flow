-- CreateTable
CREATE TABLE "BillCycleSkip" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "cycleDueDate" DATE NOT NULL,
    "skippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillCycleSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillCycleSkip_householdId_idx" ON "BillCycleSkip"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "BillCycleSkip_billId_cycleDueDate_key" ON "BillCycleSkip"("billId", "cycleDueDate");

-- AddForeignKey
ALTER TABLE "BillCycleSkip" ADD CONSTRAINT "BillCycleSkip_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillCycleSkip" ADD CONSTRAINT "BillCycleSkip_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
