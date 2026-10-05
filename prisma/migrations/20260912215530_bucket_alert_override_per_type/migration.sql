-- DropIndex
DROP INDEX "BucketAlertOverride_bucketId_userId_key";

-- AlterTable
ALTER TABLE "BucketAlertOverride" ADD COLUMN     "type" "NotificationType" NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "BucketAlertOverride_bucketId_userId_type_key" ON "BucketAlertOverride"("bucketId", "userId", "type");
