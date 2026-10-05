-- CreateTable
CREATE TABLE "TransactionOffset" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "creditTransactionId" TEXT NOT NULL,
    "debitTransactionId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionOffset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionOffset_householdId_idx" ON "TransactionOffset"("householdId");

-- CreateIndex
CREATE INDEX "TransactionOffset_debitTransactionId_idx" ON "TransactionOffset"("debitTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionOffset_creditTransactionId_debitTransactionId_key" ON "TransactionOffset"("creditTransactionId", "debitTransactionId");

-- AddForeignKey
ALTER TABLE "TransactionOffset" ADD CONSTRAINT "TransactionOffset_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionOffset" ADD CONSTRAINT "TransactionOffset_creditTransactionId_fkey" FOREIGN KEY ("creditTransactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionOffset" ADD CONSTRAINT "TransactionOffset_debitTransactionId_fkey" FOREIGN KEY ("debitTransactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
