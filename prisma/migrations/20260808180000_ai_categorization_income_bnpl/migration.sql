-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "aiSuggestedBucketId" TEXT,
ADD COLUMN     "isIncome" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SuggestionDismissal" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuggestionDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuggestionDismissal_householdId_kind_key_key" ON "SuggestionDismissal"("householdId", "kind", "key");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_aiSuggestedBucketId_fkey" FOREIGN KEY ("aiSuggestedBucketId") REFERENCES "Bucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuggestionDismissal" ADD CONSTRAINT "SuggestionDismissal_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
