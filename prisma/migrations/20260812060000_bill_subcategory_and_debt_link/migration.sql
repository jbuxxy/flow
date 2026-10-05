-- CreateTable
CREATE TABLE "BillSubcategory" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "category" "BillCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSubcategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillSubcategory_householdId_idx" ON "BillSubcategory"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "BillSubcategory_householdId_category_name_key" ON "BillSubcategory"("householdId", "category", "name");

-- AddForeignKey
ALTER TABLE "BillSubcategory" ADD CONSTRAINT "BillSubcategory_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "RecurringBill" ADD COLUMN     "subcategoryId" TEXT,
ADD COLUMN     "debtId" TEXT;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "BillSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringBill" ADD CONSTRAINT "RecurringBill_debtId_fkey" FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
