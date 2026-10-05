-- CreateTable
CREATE TABLE "BnplKeyword" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BnplKeyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BnplMerchantCheck" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "isBnpl" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BnplMerchantCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BnplKeyword_householdId_keyword_key" ON "BnplKeyword"("householdId", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "BnplMerchantCheck_householdId_merchant_key" ON "BnplMerchantCheck"("householdId", "merchant");

-- AddForeignKey
ALTER TABLE "BnplKeyword" ADD CONSTRAINT "BnplKeyword_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BnplMerchantCheck" ADD CONSTRAINT "BnplMerchantCheck_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
