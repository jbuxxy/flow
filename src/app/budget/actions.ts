"use server";

import { requireOwner } from "@/lib/access";
import { currentPeriodKey } from "@/lib/period";
import {
  confirmBudgetPlan,
  dismissBudgetPlan,
  createSinkingFund,
  redraftBudgetPlan,
  clearBudgetRedraft,
  type ConfirmBudgetPlanPayload,
} from "@/lib/budget-plan";
import { revalidateHousehold } from "@/lib/revalidate";

// Setting the month's budget is owner-only ("full financials") — a non-owner
// full-access member (a spouse scoped to buckets/budget) can view the proposed
// plan on /budget but can't confirm it, skip it, or change a bucket value. Same
// bar as /debts went to on 2026-08-21: view stays open, every mutation is
// requireOwner. The client also renders read-only for non-owners; this is the
// server-side enforcement.

export async function confirmBudgetPlanAction(payload: ConfirmBudgetPlanPayload): Promise<{ error?: string }> {
  const { user } = await requireOwner();
  const res = await confirmBudgetPlan(user.householdId, payload);
  if (res.error) return res;
  revalidateHousehold();
  return {};
}

export async function dismissBudgetPlanAction(): Promise<void> {
  const { user } = await requireOwner();
  await dismissBudgetPlan(user.householdId, currentPeriodKey());
  revalidateHousehold();
}

export async function createSinkingFundAction(input: {
  name: string;
  monthlyCents: number;
  targetMonth: string | null;
}): Promise<{ error?: string }> {
  const { user } = await requireOwner();
  const res = await createSinkingFund(user.householdId, input);
  if (res.error) return res;
  revalidateHousehold();
  return {};
}

// "Tell the AI what you want" — owner-only like every other budget mutation.
export async function redraftBudgetPlanAction(instructions: string): Promise<{ error?: string }> {
  const { user } = await requireOwner();
  const res = await redraftBudgetPlan(user.householdId, currentPeriodKey(), instructions);
  if (res.error) return res;
  revalidateHousehold();
  return {};
}

export async function clearBudgetRedraftAction(): Promise<void> {
  const { user } = await requireOwner();
  await clearBudgetRedraft(user.householdId, currentPeriodKey());
  revalidateHousehold();
}
