-- CreateEnum
CREATE TYPE "AiConnectionStatus" AS ENUM ('ACTIVE', 'ERROR');

-- AlterTable
ALTER TABLE "HouseholdAiSettings" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "status" "AiConnectionStatus" NOT NULL DEFAULT 'ACTIVE';
