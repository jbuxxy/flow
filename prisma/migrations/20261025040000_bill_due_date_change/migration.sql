CREATE TABLE "BillDueDateChange" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillDueDateChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillDueDateChange_billId_createdAt_idx" ON "BillDueDateChange"("billId", "createdAt");

ALTER TABLE "BillDueDateChange" ADD CONSTRAINT "BillDueDateChange_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BillDueDateChange" ADD CONSTRAINT "BillDueDateChange_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
