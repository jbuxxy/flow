-- CreateTable
CREATE TABLE "PayoffExtraSnapshot" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "isPayoff" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayoffExtraSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoffExtraSnapshot_householdId_idx" ON "PayoffExtraSnapshot"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoffExtraSnapshot_debtId_weekStart_key" ON "PayoffExtraSnapshot"("debtId", "weekStart");

-- AddForeignKey
ALTER TABLE "PayoffExtraSnapshot" ADD CONSTRAINT "PayoffExtraSnapshot_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoffExtraSnapshot" ADD CONSTRAINT "PayoffExtraSnapshot_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
