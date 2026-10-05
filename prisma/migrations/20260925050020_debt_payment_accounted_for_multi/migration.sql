-- CreateTable
CREATE TABLE "DebtPaymentAccountedFor" (
    "id" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "purchaseTransactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DebtPaymentAccountedFor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DebtPaymentAccountedFor_paymentTransactionId_idx" ON "DebtPaymentAccountedFor"("paymentTransactionId");

-- CreateIndex
CREATE INDEX "DebtPaymentAccountedFor_purchaseTransactionId_idx" ON "DebtPaymentAccountedFor"("purchaseTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtPaymentAccountedFor_paymentTransactionId_purchaseTransa_key" ON "DebtPaymentAccountedFor"("paymentTransactionId", "purchaseTransactionId");

-- AddForeignKey
ALTER TABLE "DebtPaymentAccountedFor" ADD CONSTRAINT "DebtPaymentAccountedFor_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtPaymentAccountedFor" ADD CONSTRAINT "DebtPaymentAccountedFor_purchaseTransactionId_fkey" FOREIGN KEY ("purchaseTransactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: copy every existing single-purchase link into the new join table
-- before dropping the scalar column that used to hold it (only 3 rows in
-- production as of this migration).
INSERT INTO "DebtPaymentAccountedFor" ("id", "paymentTransactionId", "purchaseTransactionId")
SELECT gen_random_uuid()::text, "id", "accountedForByTransactionId"
FROM "Transaction"
WHERE "accountedForByTransactionId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_accountedForByTransactionId_fkey";

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "accountedForByTransactionId";
