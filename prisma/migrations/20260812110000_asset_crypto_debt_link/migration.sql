-- AlterEnum
ALTER TYPE "AssetSource" ADD VALUE 'LIVE_PRICE';

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'CRYPTO';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "debtId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Asset_debtId_key" ON "Asset"("debtId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
