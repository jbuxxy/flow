-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "budgetTracked" BOOLEAN NOT NULL DEFAULT true;

-- Backfill existing accounts: only CHECKING/SAVINGS start out budget-tracked
-- (see the schema comment on Account.budgetTracked) — everything already
-- synced as a CREDIT_CARD/LOAN/INVESTMENT/OTHER account defaults to false
-- instead of inheriting the column's blanket DEFAULT true, matching the
-- same type-based default simplefin-sync.ts now applies for accounts
-- created after this migration.
UPDATE "Account" SET "budgetTracked" = false WHERE "accountType" NOT IN ('CHECKING', 'SAVINGS');
