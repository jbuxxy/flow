-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('GEMINI', 'OPENAI', 'ANTHROPIC', 'GROK');

-- CreateTable
CREATE TABLE "HouseholdAiSettings" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HouseholdAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HouseholdAiSettings_householdId_key" ON "HouseholdAiSettings"("householdId");

-- AddForeignKey
ALTER TABLE "HouseholdAiSettings" ADD CONSTRAINT "HouseholdAiSettings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
