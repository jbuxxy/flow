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
// keeps the Household row, every User (login/2FA untouched), and AI
// provider config, then resets onboarding so the household can optionally
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
