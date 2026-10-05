-- CreateTable
CREATE TABLE "PayoffExtraSkip" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "paycheckDate" DATE NOT NULL,
    "skippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoffExtraSkip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoffExtraSkip_householdId_idx" ON "PayoffExtraSkip"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoffExtraSkip_debtId_paycheckDate_key" ON "PayoffExtraSkip"("debtId", "paycheckDate");

-- AddForeignKey
ALTER TABLE "PayoffExtraSkip" ADD CONSTRAINT "PayoffExtraSkip_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoffExtraSkip" ADD CONSTRAINT "PayoffExtraSkip_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
