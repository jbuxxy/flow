-- CreateTable
CREATE TABLE "ReceiptMerchantAlias" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "receiptParty" TEXT NOT NULL,
    "merchantText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptMerchantAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceiptMerchantAlias_householdId_receiptParty_idx" ON "ReceiptMerchantAlias"("householdId", "receiptParty");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptMerchantAlias_householdId_receiptParty_merchantText_key" ON "ReceiptMerchantAlias"("householdId", "receiptParty", "merchantText");

-- AddForeignKey
ALTER TABLE "ReceiptMerchantAlias" ADD CONSTRAINT "ReceiptMerchantAlias_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
