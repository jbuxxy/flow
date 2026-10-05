-- Manual transaction entry was removed 2026-08-15; every Transaction is
-- synced bank history, so the source discriminator (and its now-unused
-- MANUAL value) carries no information. Prod verified: 0 rows with
-- source <> 'SYNCED' before this runs.

-- AlterTable
ALTER TABLE "Transaction" DROP COLUMN "source";

-- DropEnum
DROP TYPE "TransactionSource";
