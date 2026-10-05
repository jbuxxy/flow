-- CreateEnum
CREATE TYPE "DebtAmountReviewSource" AS ENUM ('BANK_SYNC', 'EMAIL');

-- CreateEnum
CREATE TYPE "BillNoticeTargetType" AS ENUM ('BILL', 'DEBT');

-- CreateEnum
CREATE TYPE "BillNoticeStatus" AS ENUM ('PENDING', 'REVIEW_CREATED', 'NO_CHANGE', 'AMBIGUOUS', 'UNMATCHED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'BILL_AMOUNT_REVIEW';

-- AlterTable
ALTER TABLE "DebtAmountReview" ADD COLUMN     "accountLast4" TEXT,
ADD COLUMN     "billNoticeEmailId" TEXT,
ADD COLUMN     "dueDate" DATE,
ADD COLUMN     "source" "DebtAmountReviewSource" NOT NULL DEFAULT 'BANK_SYNC',
ALTER COLUMN "transactionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BillNoticeEmail" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "emailConnectionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "billerName" TEXT NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "dueDate" DATE,
    "accountLast4" TEXT,
    "targetType" "BillNoticeTargetType",
    "billId" TEXT,
    "debtId" TEXT,
    "status" "BillNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillNoticeEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillAmountReview" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "billNoticeEmailId" TEXT NOT NULL,
    "observedAmountCents" INTEGER NOT NULL,
    "expectedAmountCents" INTEGER NOT NULL,
    "dueDate" DATE,
    "accountLast4" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillAmountReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillNoticeEmail_householdId_idx" ON "BillNoticeEmail"("householdId");

-- CreateIndex
CREATE INDEX "BillNoticeEmail_status_idx" ON "BillNoticeEmail"("status");

-- CreateIndex
CREATE INDEX "BillNoticeEmail_billId_idx" ON "BillNoticeEmail"("billId");

-- CreateIndex
CREATE INDEX "BillNoticeEmail_debtId_idx" ON "BillNoticeEmail"("debtId");

-- CreateIndex
CREATE UNIQUE INDEX "BillNoticeEmail_emailConnectionId_messageId_key" ON "BillNoticeEmail"("emailConnectionId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "BillAmountReview_billNoticeEmailId_key" ON "BillAmountReview"("billNoticeEmailId");

-- CreateIndex
CREATE INDEX "BillAmountReview_householdId_idx" ON "BillAmountReview"("householdId");

-- CreateIndex
CREATE INDEX "BillAmountReview_billId_idx" ON "BillAmountReview"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "DebtAmountReview_billNoticeEmailId_key" ON "DebtAmountReview"("billNoticeEmailId");

-- AddForeignKey
ALTER TABLE "DebtAmountReview" ADD CONSTRAINT "DebtAmountReview_billNoticeEmailId_fkey" FOREIGN KEY ("billNoticeEmailId") REFERENCES "BillNoticeEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillNoticeEmail" ADD CONSTRAINT "BillNoticeEmail_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillNoticeEmail" ADD CONSTRAINT "BillNoticeEmail_emailConnectionId_fkey" FOREIGN KEY ("emailConnectionId") REFERENCES "EmailConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillNoticeEmail" ADD CONSTRAINT "BillNoticeEmail_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillNoticeEmail" ADD CONSTRAINT "BillNoticeEmail_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAmountReview" ADD CONSTRAINT "BillAmountReview_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAmountReview" ADD CONSTRAINT "BillAmountReview_billId_fkey" FOREIGN KEY ("billId") REFERENCES "RecurringBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAmountReview" ADD CONSTRAINT "BillAmountReview_billNoticeEmailId_fkey" FOREIGN KEY ("billNoticeEmailId") REFERENCES "BillNoticeEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;
