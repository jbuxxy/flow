-- CreateEnum
CREATE TYPE "BillCategory" AS ENUM ('HOUSING', 'UTILITIES', 'INSURANCE', 'LOAN', 'SUBSCRIPTION', 'OTHER');

-- AlterTable
ALTER TABLE "RecurringBill" ADD COLUMN     "category" "BillCategory" NOT NULL DEFAULT 'OTHER';
