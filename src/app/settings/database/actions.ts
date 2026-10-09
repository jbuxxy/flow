"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/access";

// Full JSON snapshot of the household's data, for self-service backup —
// mirrors the manual pg_dump-to-a-folder process this household already
// does ad hoc (see WORKING_ON.md), just reachable from the UI. Excludes:
// login/2FA fields (User.passwordHash/totpSecretEncrypted), bank/AI
// credentials (BankConnection.accessUrlEncrypted, HouseholdAiSettings.
// apiKeyEncrypted — neither model is queried at all), and Report.pdfBytes
// (binary; served separately via /reports/archive/[id]/pdf, would bloat a
// JSON export considerably for something already downloadable on its own).
export async function exportHouseholdData(): Promise<string> {
  const { user } = await requireOwner();
  const householdId = user.householdId;

  const [
    household,
    buckets,
    transactions,
    merchantRules,
    recurringPatterns,
    billCategories,
    recurringBills,
    debts,
    debtPayments,
    debtSnapshots,
    netWorthSnapshots,
    savingsGoals,
    accounts,
    incomes,
    assets,
    reports,
  ] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId } }),
    db.bucket.findMany({ where: { householdId } }),
    db.transaction.findMany({ where: { householdId } }),
    db.merchantRule.findMany({ where: { householdId } }),
    db.recurringPattern.findMany({ where: { householdId } }),
    db.billCategory.findMany({ where: { householdId } }),
    db.recurringBill.findMany({ where: { householdId } }),
    db.debt.findMany({ where: { householdId } }),
    db.debtPayment.findMany({ where: { householdId } }),
    db.debtSnapshot.findMany({ where: { householdId } }),
    db.netWorthSnapshot.findMany({ where: { householdId } }),
    db.savingsGoal.findMany({ where: { householdId } }),
    db.account.findMany({ where: { householdId } }),
    db.income.findMany({ where: { householdId } }),
    db.asset.findMany({ where: { householdId } }),
    db.report.findMany({
      where: { householdId },
      select: { id: true, type: true, periodKey: true, status: true, findings: true, narrative: true, createdAt: true, archivedAt: true },
    }),
  ]);

  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      version: 1,
      household: {
        name: household.name,
        goalPosture: household.goalPosture,
        adultsCount: household.adultsCount,
        kidsCount: household.kidsCount,
        payoffOrder: household.payoffOrder,
        payoffExtraCents: household.payoffExtraCents,
        payoffRollFreedMinimums: household.payoffRollFreedMinimums,
        payoffPlanEnabled: household.payoffPlanEnabled,
        incomeCalcMethod: household.incomeCalcMethod,
        includeP2PInIncomeCalc: household.includeP2PInIncomeCalc,
      },
      buckets,
      transactions,
      merchantRules,
      recurringPatterns,
      billCategories,
      recurringBills,
      debts,
      debtPayments,
      debtSnapshots,
      netWorthSnapshots,
      savingsGoals,
      accounts,
      incomes,
      assets,
      reports,
    },
    null,
    2,
  );
}

export type PurgeFinancialDataState = { error?: string };

const purgeSchema = z.object({ confirmText: z.string() });

// "Wipe financial data, keep login" — deletes every financial record but
// keeps the Household row, every User (login/2FA untouched), AI provider
// config and connected mailboxes, then resets onboarding so the household can optionally
// re-run the setup wizard against a clean slate. Distinct from
// deleteHousehold (danger-zone.tsx), which removes the household and its
// members entirely.
export async function purgeFinancialData(
  _prev: PurgeFinancialDataState,
  formData: FormData,
): Promise<PurgeFinancialDataState> {
  const { user } = await requireOwner();

  const parsed = purgeSchema.safeParse({ confirmText: formData.get("confirmText") });
  if (!parsed.success || parsed.data.confirmText.trim() !== "PURGE") {
    return { error: 'Type "PURGE" to confirm.' };
  }

  const householdId = user.householdId;

  await db.$transaction([
    // Transaction first — every other model's FK to it (or from it) is
    // SetNull/Cascade, but clearing this first means no later delete in
    // this list ever has to reason about a still-linked transaction.
    db.transaction.deleteMany({ where: { householdId } }),
    db.bucket.deleteMany({ where: { householdId } }), // cascades BucketAlert
    db.debt.deleteMany({ where: { householdId } }), // cascades DebtPayment, PayoffExtraConfirmation, PayoffExtraSkip
    db.debtSnapshot.deleteMany({ where: { householdId } }),
    db.netWorthSnapshot.deleteMany({ where: { householdId } }),
    db.recurringBill.deleteMany({ where: { householdId } }),
    db.billCategory.deleteMany({ where: { householdId } }),
    db.merchantRule.deleteMany({ where: { householdId } }),
    db.recurringPattern.deleteMany({ where: { householdId } }),
    db.savingsGoal.deleteMany({ where: { householdId } }),
    db.income.deleteMany({ where: { householdId } }),
    db.asset.deleteMany({ where: { householdId } }),
    db.account.deleteMany({ where: { householdId } }),
    db.bankConnection.deleteMany({ where: { householdId } }),
    db.report.deleteMany({ where: { householdId } }),
    db.suggestionDismissal.deleteMany({ where: { householdId } }),
    db.billsInsight.deleteMany({ where: { householdId } }),
    // Everything else derived from the wiped data — these used to survive a
    // purge (2026-10-08 review): matched receipts kept matchState MATCHED
    // with no transaction (matchReceipts only ever looks at UNMATCHED/
    // AMBIGUOUS, so they could never relink), and this month's BudgetPlan
    // pointed at deleted buckets while blocking a fresh one. Most of the
    // rest already cascade from a parent deleted above; listing them keeps
    // the purge complete regardless of which ones do.
    db.receipt.deleteMany({ where: { householdId } }),
    db.receiptMerchantAlias.deleteMany({ where: { householdId } }),
    db.billNoticeEmail.deleteMany({ where: { householdId } }),
    db.budgetPlan.deleteMany({ where: { householdId } }),
    db.bucketAdHocTopUp.deleteMany({ where: { householdId } }),
    db.transactionOffset.deleteMany({ where: { householdId } }),
    db.learnedKeyword.deleteMany({ where: { householdId } }),
    db.merchantKeywordCheck.deleteMany({ where: { householdId } }),
    db.nudgeAlert.deleteMany({ where: { householdId } }),
    db.cycleAlert.deleteMany({ where: { householdId } }),
    db.billAmountReview.deleteMany({ where: { householdId } }),
    db.billCycleSkip.deleteMany({ where: { householdId } }),
    db.billExtraChargeRule.deleteMany({ where: { householdId } }),
    db.debtAmountReview.deleteMany({ where: { householdId } }),
    db.debtBalanceReview.deleteMany({ where: { householdId } }),
    db.debtMinimumSkip.deleteMany({ where: { householdId } }),
    db.patternPaymentReview.deleteMany({ where: { householdId } }),
    db.payoffExtraConfirmation.deleteMany({ where: { householdId } }),
    db.payoffExtraSkip.deleteMany({ where: { householdId } }),
    db.payoffExtraSnapshot.deleteMany({ where: { householdId } }),
    // Mail connections are kept (credentials, like the AI settings), but
    // their scan cursors restart so receipts re-import against fresh data.
    db.emailConnection.updateMany({
      where: { householdId },
      data: { lastSeenUid: null, oldestPolledUid: null, lastPolledAt: null },
    }),
    db.household.update({
      where: { id: householdId },
      data: { onboardingCompletedAt: null, onboardingStep: "PROFILE" },
    }),
  ]);

  revalidatePath("/");
  revalidatePath("/buckets");
  revalidatePath("/debts");
  revalidatePath("/reports");
  revalidatePath("/settings");
  return {};
}

// Voluntary re-entry into the setup wizard — each of its phases is written
// to be re-entry safe (see src/app/onboarding/actions.ts): it pre-fills
// existing profile values, skips reconnecting already-connected sources, and
// skips bucket creation entirely if buckets already exist.
export async function restartOnboarding(): Promise<void> {
  const { user } = await requireOwner();
  await db.household.update({
    where: { id: user.householdId },
    data: { onboardingCompletedAt: null, onboardingStep: "PROFILE" },
  });
  revalidatePath("/");
}
