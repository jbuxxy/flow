-- CreateEnum
CREATE TYPE "BucketAlertOverrideValue" AS ENUM ('ALWAYS', 'NEVER');

-- CreateTable
CREATE TABLE "BucketAlertOverride" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "override" "BucketAlertOverrideValue" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BucketAlertOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BucketAlertOverride_userId_idx" ON "BucketAlertOverride"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BucketAlertOverride_bucketId_userId_key" ON "BucketAlertOverride"("bucketId", "userId");

-- AddForeignKey
ALTER TABLE "BucketAlertOverride" ADD CONSTRAINT "BucketAlertOverride_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketAlertOverride" ADD CONSTRAINT "BucketAlertOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
