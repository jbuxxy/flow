-- CreateEnum
CREATE TYPE "BucketTrackingMode" AS ENUM ('SPEND', 'RECURRING', 'MIXED');

-- AlterTable
ALTER TABLE "Bucket" ADD COLUMN     "trackingMode" "BucketTrackingMode" NOT NULL DEFAULT 'SPEND';
