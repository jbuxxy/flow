-- CreateEnum
CREATE TYPE "EmailConnectionStatus" AS ENUM ('ACTIVE', 'ERROR', 'PAUSED');

-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('ORDER_CONFIRMATION', 'PAYMENT_SENT', 'PAYMENT_RECEIVED', 'SUBSCRIPTION', 'SHIPPING', 'OTHER');

-- CreateEnum
CREATE TYPE "ReceiptMatchState" AS ENUM ('UNMATCHED', 'MATCHED', 'AMBIGUOUS', 'STALE', 'DISMISSED');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "receiptItems" JSONB,
ADD COLUMN     "receiptTotalCents" INTEGER,
ADD COLUMN     "resolvedMerchant" TEXT;

-- CreateTable
CREATE TABLE "EmailConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "imapUser" TEXT NOT NULL,
    "imapPasswordEncrypted" TEXT NOT NULL,
    "status" "EmailConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "lastSeenUid" INTEGER,
    "aiConsentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "emailConnectionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "kind" "ReceiptKind" NOT NULL,
    "party" TEXT,
    "totalCents" INTEGER,
    "occurredOn" DATE,
    "orderNumber" TEXT,
    "noteText" TEXT,
    "lineItems" JSONB,
    "transactionId" TEXT,
    "matchState" "ReceiptMatchState" NOT NULL DEFAULT 'UNMATCHED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_userId_key" ON "EmailConnection"("userId");

-- CreateIndex
CREATE INDEX "EmailConnection_householdId_idx" ON "EmailConnection"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_transactionId_key" ON "Receipt"("transactionId");

-- CreateIndex
CREATE INDEX "Receipt_householdId_idx" ON "Receipt"("householdId");

-- CreateIndex
CREATE INDEX "Receipt_matchState_idx" ON "Receipt"("matchState");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_emailConnectionId_messageId_key" ON "Receipt"("emailConnectionId", "messageId");

-- AddForeignKey
ALTER TABLE "EmailConnection" ADD CONSTRAINT "EmailConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailConnection" ADD CONSTRAINT "EmailConnection_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_emailConnectionId_fkey" FOREIGN KEY ("emailConnectionId") REFERENCES "EmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

