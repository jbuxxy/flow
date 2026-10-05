"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireFullAccess } from "@/lib/access";
import type { IncomeCalcMethod, HouseholdGoalPosture } from "@prisma/client";

export type DeleteHouseholdState = { error?: string };

const deleteSchema = z.object({ confirmName: z.string() });

export async function deleteHousehold(
  _prev: DeleteHouseholdState,
  formData: FormData,
): Promise<DeleteHouseholdState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "OWNER") return { error: "Only the household owner can do this." };

  const parsed = deleteSchema.safeParse({ confirmName: formData.get("confirmName") });
  if (!parsed.success) return { error: "Type the household name to confirm." };

  const household = await db.household.findUnique({ where: { id: session.user.householdId } });
  if (!household) return { error: "Household not found." };

  if (parsed.data.confirmName.trim() !== household.name) {
    return { error: "That doesn't match the household name." };
  }

  // Cascades: users, buckets, transactions, debts, savings goals, bank
  // connection, accounts, income all carry onDelete: Cascade to Household.
  await db.household.delete({ where: { id: household.id } });

  await signOut({ redirectTo: "/register" });
  return {};
}

const INCOME_CALC_METHODS: IncomeCalcMethod[] = ["MONTHLY_AVERAGE", "BIWEEKLY_CONSERVATIVE"];

// Both auto-save immediately (no form/Save button) — same "flip it, it's
// saved" feel as AccountEditor's budgetTracked toggle. Feeds
// getIncomeSummary (src/lib/income.ts), so /income's total, /buckets'
// allocation summary, and (via getHouseholdSavingsCapacity, src/lib/
// savings.ts) the savings-capacity figure behind goal AI feedback all pick
// up the change on next load.
export async function updateIncomeCalcMethod(method: IncomeCalcMethod): Promise<void> {
  const session = await requireFullAccess();
  if (!INCOME_CALC_METHODS.includes(method)) return;

  await db.household.update({ where: { id: session.user.householdId }, data: { incomeCalcMethod: method } });
  revalidatePath("/settings/income");
  revalidatePath("/settings");
  revalidatePath("/income");
  revalidatePath("/buckets");
}

export async function setIncludeP2PInIncomeCalc(include: boolean): Promise<void> {
  const session = await requireFullAccess();

  await db.household.update({ where: { id: session.user.householdId }, data: { includeP2PInIncomeCalc: include } });
  revalidatePath("/settings/income");
  revalidatePath("/settings");
  revalidatePath("/income");
  revalidatePath("/buckets");
}

// See Household.autoApplyAdHocIncomeToBuckets's own schema comment and
// autoApplyAdHocIncomeToBuckets (bucket-ad-hoc-topup.ts) for the mechanism
// this toggles.
export async function setAutoApplyAdHocIncomeToBuckets(enabled: boolean): Promise<void> {
  const session = await requireFullAccess();

  await db.household.update({
    where: { id: session.user.householdId },
    data: { autoApplyAdHocIncomeToBuckets: enabled },
  });
  revalidatePath("/settings/income");
  revalidatePath("/settings");
  revalidatePath("/income");
  revalidatePath("/buckets");
}

const GOAL_POSTURES: HouseholdGoalPosture[] = ["DEBT_PAYDOWN", "SAVINGS_FOCUSED", "BALANCED"];

// Shared by settings/household/household-profile-settings.tsx and the
// onboarding wizard's "profile" phase (src/app/onboarding/actions.ts calls
// this same function) — one implementation, no duplicated validation. Feeds
// generateMonthlyReportContent/generateStartupReportContent (src/lib/ai.ts)
// as context for which posture AI suggestions should lean into, and (via
// getHouseholdSavingsCapacity/generateGoalFeedback, src/lib/savings.ts +
// ai.ts) which side of debt-vs-savings a goal's coaching should favor.
export async function updateGoalPosture(posture: HouseholdGoalPosture): Promise<void> {
  const session = await requireFullAccess();
  if (!GOAL_POSTURES.includes(posture)) return;

  await db.household.update({ where: { id: session.user.householdId }, data: { goalPosture: posture } });
  revalidatePath("/settings/household");
  revalidatePath("/settings");
  // The posture now also drives the "Set the Month" surplus routing + the
  // Reports realignment card, so refresh those too.
  revalidatePath("/reports");
  revalidatePath("/budget");
}

// Feeds the same AI prompts as updateGoalPosture above (family size affects
// realistic bucket sizing, e.g. groceries/dining baselines).
export async function updateHouseholdSize(adultsCount: number, kidsCount: number): Promise<void> {
  const session = await requireFullAccess();

  const adults = Math.round(adultsCount);
  const kids = Math.round(kidsCount);
  if (!Number.isFinite(adults) || adults < 1 || adults > 10) return;
  if (!Number.isFinite(kids) || kids < 0 || kids > 10) return;

  await db.household.update({ where: { id: session.user.householdId }, data: { adultsCount: adults, kidsCount: kids } });
  revalidatePath("/settings/household");
  revalidatePath("/settings");
}
