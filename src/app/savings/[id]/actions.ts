"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireFullAccess, requireOwned } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { checkAndSendGoalAlerts, goalSavedCents, resolveGoalAccountLink } from "@/lib/savings";
import { revalidateHousehold } from "@/lib/revalidate";

function requireGoalInHousehold(goalId: string, householdId: string) {
  return requireOwned(db.savingsGoal.findUnique({ where: { id: goalId } }), householdId);
}

const contributeSchema = z.object({
  goalId: z.string(),
  amount: z.string(),
  occurredOn: z.string(),
  note: z.string().trim().max(200).optional(),
});

export type ContributeState = { error?: string };

export async function addContribution(
  _prev: ContributeState,
  formData: FormData,
): Promise<ContributeState> {
  const session = await requireFullAccess();

  const parsed = contributeSchema.safeParse({
    goalId: formData.get("goalId"),
    amount: formData.get("amount"),
    occurredOn: formData.get("occurredOn"),
    note: formData.get("note") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const goal = await requireGoalInHousehold(parsed.data.goalId, session.user.householdId);

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) return { error: "Enter a valid amount." };

  const occurredOn = new Date(parsed.data.occurredOn);
  if (Number.isNaN(occurredOn.getTime())) return { error: "Enter a valid date." };

  await db.$transaction([
    db.savingsContribution.create({
      data: {
        goalId: goal.id,
        amountCents,
        occurredOn,
        note: parsed.data.note,
        createdByUserId: session.user.id,
      },
    }),
    db.savingsGoal.update({
      where: { id: goal.id },
      data: { currentAmountCents: { increment: amountCents } },
    }),
  ]);

  await checkAndSendGoalAlerts(goal.id);

  revalidateHousehold();
  return {};
}

export async function linkGoalAccount(goalId: string, accountId: string) {
  const session = await requireFullAccess();

  const goal = await requireGoalInHousehold(goalId, session.user.householdId);

  if (!accountId) {
    // Unlinking → back to manual tracking. Keep the progress made *toward the
    // goal* (balance − baseline) as the new manually-tracked amount, not the
    // whole account balance, and clear the baseline.
    await db.savingsGoal.update({
      where: { id: goal.id },
      data: { accountId: null, source: "MANUAL", currentAmountCents: goalSavedCents(goal), baselineCents: 0 },
    });
    revalidateHousehold();
    return;
  }

  const link = await resolveGoalAccountLink(accountId, session.user.householdId);
  if (!link.accountId) return; // invalid/foreign account id

  await db.savingsGoal.update({
    where: { id: goal.id },
    data: {
      accountId: link.accountId,
      source: link.source,
      // Re-baseline to the new account's balance now — progress restarts from
      // whatever's currently in it, same as a fresh link.
      ...(link.currentAmountCents !== undefined ? { currentAmountCents: link.currentAmountCents } : {}),
      ...(link.baselineCents !== undefined ? { baselineCents: link.baselineCents } : {}),
    },
  });
  await checkAndSendGoalAlerts(goal.id);

  revalidateHousehold();
}

const updateGoalSchema = z.object({
  goalId: z.string(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  targetAmount: z.string(),
  targetDate: z.string().optional(),
});

export type UpdateGoalState = { error?: string };

export async function updateGoal(
  _prev: UpdateGoalState,
  formData: FormData,
): Promise<UpdateGoalState> {
  const session = await requireFullAccess();

  const parsed = updateGoalSchema.safeParse({
    goalId: formData.get("goalId"),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    targetAmount: formData.get("targetAmount"),
    targetDate: formData.get("targetDate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const goal = await requireGoalInHousehold(parsed.data.goalId, session.user.householdId);

  const targetAmountCents = parseDollarsToCents(parsed.data.targetAmount);
  if (targetAmountCents === null || targetAmountCents === 0) {
    return { error: "Enter a valid target amount." };
  }

  let targetDate: Date | null = null;
  if (parsed.data.targetDate) {
    const d = new Date(parsed.data.targetDate);
    if (Number.isNaN(d.getTime())) return { error: "Enter a valid target date." };
    targetDate = d;
  }

  await db.savingsGoal.update({
    where: { id: goal.id },
    data: {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      targetAmountCents,
      targetDate,
    },
  });

  revalidateHousehold();
  return {};
}

export async function toggleGoalReminder(goalId: string, enabled: boolean) {
  const session = await requireFullAccess();

  const goal = await requireGoalInHousehold(goalId, session.user.householdId);
  await db.savingsGoal.update({ where: { id: goal.id }, data: { reminderEnabled: enabled } });

  revalidateHousehold();
}

export async function deleteGoal(goalId: string) {
  const session = await requireFullAccess();

  const goal = await requireGoalInHousehold(goalId, session.user.householdId);
  await db.savingsGoal.delete({ where: { id: goal.id } });

  revalidateHousehold();
  redirect("/savings");
}
