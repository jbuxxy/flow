-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "isRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "refundTo" TEXT,
ADD COLUMN "refundToLast4" TEXT;
