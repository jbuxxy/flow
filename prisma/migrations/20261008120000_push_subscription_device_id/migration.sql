-- AlterTable
ALTER TABLE "PushSubscription" ADD COLUMN     "deviceId" TEXT;

-- CreateIndex
CREATE INDEX "PushSubscription_userId_deviceId_idx" ON "PushSubscription"("userId", "deviceId");
