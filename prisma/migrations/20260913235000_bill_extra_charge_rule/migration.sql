-- CreateTable
CREATE TABLE "BillExtraChargeRule" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillExtraChargeRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillExtraChargeRule_householdId_merchant_idx" ON "BillExtraChargeRule"("householdId", "merchant");

-- CreateIndex
CREATE UNIQUE INDEX "BillExtraChargeRule_billId_merchant_key" ON "BillExtraChargeRule"("billId", "merchant");

-- AddForeignKey
ALTER TABLE "BillExtraChargeRule" ADD CONSTRAINT "BillExtraChargeRule_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillExtraChargeRule" ADD CONSTRAINT "BillExtraChargeRule_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
