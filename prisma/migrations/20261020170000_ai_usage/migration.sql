CREATE TABLE "AiUsage" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "thinkingTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiUsage_householdId_createdAt_idx" ON "AiUsage"("householdId", "createdAt");

ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
