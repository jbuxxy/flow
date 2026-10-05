-- CreateEnum
CREATE TYPE "DebtKind" AS ENUM ('CARD', 'LOAN', 'BNPL');

-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "kind" "DebtKind" NOT NULL DEFAULT 'CARD';

-- Existing INSTALLMENT debts are all BNPL today — CARD is only the right
-- default for REVOLVING debts (see schema.prisma's DebtKind doc comment).
UPDATE "Debt" SET "kind" = 'BNPL' WHERE "debtType" = 'INSTALLMENT';
