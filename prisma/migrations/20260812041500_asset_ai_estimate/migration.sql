-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('MANUAL', 'SIMPLEFIN', 'AI_ESTIMATE');

-- AlterTable: Asset.source moves from the shared DataSource enum to its own
-- AssetSource enum (adds AI_ESTIMATE without widening DataSource, which is
-- also used by Transaction/Debt/RecurringBill).
ALTER TABLE "Asset" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "Asset" ALTER COLUMN "source" TYPE "AssetSource" USING ("source"::text::"AssetSource");
ALTER TABLE "Asset" ALTER COLUMN "source" SET DEFAULT 'MANUAL';

ALTER TABLE "Asset" ADD COLUMN     "estimateDetails" JSONB,
ADD COLUMN     "estimateUpdatedAt" TIMESTAMP(3);
