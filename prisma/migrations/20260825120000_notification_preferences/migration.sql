-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('BUCKET_WARNING', 'BUCKET_EXCEEDED', 'BUCKET_PACE', 'SAVINGS_MILESTONE', 'SAVINGS_WEEKLY_NUDGE', 'DEBT_AMOUNT_REVIEW', 'NEW_CYCLE', 'NEW_REPORT', 'WEEKLY_BUCKET_REPORT');

-- AlterTable
ALTER TABLE "Bucket" ADD COLUMN     "weeklyReportEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CycleAlert" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CycleAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BucketDigest" (
    "id" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BucketDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_type_key" ON "NotificationPreference"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CycleAlert_householdId_periodKey_key" ON "CycleAlert"("householdId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "BucketDigest_bucketId_weekKey_key" ON "BucketDigest"("bucketId", "weekKey");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CycleAlert" ADD CONSTRAINT "CycleAlert_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BucketDigest" ADD CONSTRAINT "BucketDigest_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "Bucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
