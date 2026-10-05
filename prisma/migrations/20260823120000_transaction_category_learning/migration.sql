-- AlterTable
ALTER TABLE "MerchantRule" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "RecurringPattern" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "aiSuggestedCategoryId" TEXT,
ADD COLUMN     "categoryId" TEXT;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_aiSuggestedCategoryId_fkey" FOREIGN KEY ("aiSuggestedCategoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRule" ADD CONSTRAINT "MerchantRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringPattern" ADD CONSTRAINT "RecurringPattern_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BillCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
