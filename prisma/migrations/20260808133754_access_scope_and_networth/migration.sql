-- CreateEnum
CREATE TYPE "DashboardScope" AS ENUM ('FULL', 'BUCKETS_ONLY');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('RETIREMENT_401K', 'RETIREMENT_IRA', 'HOME_EQUITY', 'VEHICLE_EQUITY', 'INVESTMENT', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dashboardScope" "DashboardScope" NOT NULL DEFAULT 'FULL';

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetType" "AssetType" NOT NULL DEFAULT 'OTHER',
    "valueCents" INTEGER NOT NULL,
    "asOfDate" DATE NOT NULL,
    "source" "DataSource" NOT NULL DEFAULT 'MANUAL',
    "accountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_householdId_idx" ON "Asset"("householdId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

