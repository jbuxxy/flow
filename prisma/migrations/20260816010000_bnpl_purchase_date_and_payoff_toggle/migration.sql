-- AlterTable
ALTER TABLE "Debt" ADD COLUMN     "includeInPayoffPlan" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "purchaseDate" DATE;
