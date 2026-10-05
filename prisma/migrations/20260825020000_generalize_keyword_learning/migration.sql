-- DropForeignKey
ALTER TABLE "BnplKeyword" DROP CONSTRAINT "BnplKeyword_householdId_fkey";

-- DropForeignKey
ALTER TABLE "BnplMerchantCheck" DROP CONSTRAINT "BnplMerchantCheck_householdId_fkey";

-- DropTable
DROP TABLE "BnplKeyword";

-- DropTable
DROP TABLE "BnplMerchantCheck";

-- CreateTable
CREATE TABLE "LearnedKeyword" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnedKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantKeywordCheck" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "isMatch" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantKeywordCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LearnedKeyword_householdId_kind_keyword_key" ON "LearnedKeyword"("householdId", "kind", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantKeywordCheck_householdId_kind_merchant_key" ON "MerchantKeywordCheck"("householdId", "kind", "merchant");

-- AddForeignKey
ALTER TABLE "LearnedKeyword" ADD CONSTRAINT "LearnedKeyword_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantKeywordCheck" ADD CONSTRAINT "MerchantKeywordCheck_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
