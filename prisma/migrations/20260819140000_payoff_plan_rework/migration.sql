-- AlterTable
ALTER TABLE "Household" DROP COLUMN "payoffAnchorDate",
DROP COLUMN "payoffCalendarMode",
DROP COLUMN "payoffMode",
ADD COLUMN     "payoffPlanEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoffRollFreedMinimums" BOOLEAN NOT NULL DEFAULT true;

-- DropEnum
DROP TYPE "PayoffCalendarMode";

-- DropEnum
DROP TYPE "PayoffMode";

-- CreateTable
CREATE TABLE "PayoffExtraConfirmation" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "debtId" TEXT NOT NULL,
    "paycheckDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoffExtraConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayoffExtraConfirmation_householdId_idx" ON "PayoffExtraConfirmation"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "PayoffExtraConfirmation_debtId_paycheckDate_key" ON "PayoffExtraConfirmation"("debtId", "paycheckDate");

-- AddForeignKey
ALTER TABLE "PayoffExtraConfirmation" ADD CONSTRAINT "PayoffExtraConfirmation_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoffExtraConfirmation" ADD CONSTRAINT "PayoffExtraConfirmation_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
