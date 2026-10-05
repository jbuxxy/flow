"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireFullAccess } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { resolveGoalAccountLink, getGoalPlan } from "@/lib/savings";
import type { GoalPlanMessage, GoalPlanProposal } from "@/lib/ai";

const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  targetAmount: z.string(),
  targetDate: z.string().optional(),
  accountId: z.string().optional(),
});

const planMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
});

export type PlanGoalState = { proposal: GoalPlanProposal | null };

// Uncached, one-shot AI turn in the conversational goal-planning flow —
// called imperatively from AddGoalForm (not tied to the real create
// submission) with the full message history so far, so the household can
// describe a goal in their own words, see AI's proposed name/amount/date,
// and keep refining before anything is persisted. `proposal: null` covers
// both "no AI provider configured" and a failed call — either way the
// client falls back to plain manual entry, same graceful-degrade contract
// every other AI feature in this app already follows. See getGoalPlan,
// src/lib/savings.ts.
export async function planGoal(messages: GoalPlanMessage[]): Promise<PlanGoalState> {
  const session = await requireFullAccess();

  const parsed = z.array(planMessageSchema).min(1).max(40).safeParse(messages);
  if (!parsed.success) return { proposal: null };

  const proposal = await getGoalPlan(session.user.householdId, parsed.data);
  return { proposal };
}

export type CreateGoalState = { error?: string };

export async function createGoal(
  _prev: CreateGoalState,
  formData: FormData,
): Promise<CreateGoalState> {
  const session = await requireFullAccess();

  const parsed = createGoalSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
    targetAmount: formData.get("targetAmount"),
    targetDate: formData.get("targetDate") || undefined,
    accountId: formData.get("accountId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const targetAmountCents = parseDollarsToCents(parsed.data.targetAmount);
  if (targetAmountCents === null || targetAmountCents === 0) {
    return { error: "Enter a valid target amount." };
  }

  let targetDate: Date | undefined;
  if (parsed.data.targetDate) {
    const d = new Date(parsed.data.targetDate);
    if (Number.isNaN(d.getTime())) return { error: "Enter a valid target date." };
    targetDate = d;
  }

  const link = await resolveGoalAccountLink(parsed.data.accountId, session.user.householdId);

  await db.savingsGoal.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      description: parsed.data.description,
      targetAmountCents,
      targetDate,
      accountId: link.accountId,
      source: link.source,
      ...(link.currentAmountCents !== undefined ? { currentAmountCents: link.currentAmountCents } : {}),
      ...(link.baselineCents !== undefined ? { baselineCents: link.baselineCents } : {}),
    },
  });

  revalidatePath("/savings");
  return {};
}
