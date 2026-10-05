-- AI-picked lucide icon key for a bucket whose name misses every keyword
-- rule in src/lib/bucket-icons.tsx (ensureBucketIcons). null = resolve live.

-- AlterTable
ALTER TABLE "Bucket" ADD COLUMN     "icon" TEXT;
