"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/access";
import {
  updateGoalPosture,
  updateHouseholdSize,
  updateIncomeCalcMethod,
  setIncludeP2PInIncomeCalc,
} from "@/app/settings/actions";
import { categorizeUncategorizedTransactions } from "@/lib/simplefin-sync";
import type { OnboardingStep } from "@prisma/client";
import { scheduleBucketIcons } from "@/lib/bucket-icons-sync";
import { revalidateHousehold } from "@/lib/revalidate";

const profileSchema = z.object({
  goalPosture: z.enum(["DEBT_PAYDOWN", "SAVINGS_FOCUSED", "BALANCED"]),
  adultsCount: z.coerce.number().int().min(1).max(10),
  kidsCount: z.coerce.number().int().min(0).max(10),
  incomeCalcMethod: z.enum(["MONTHLY_AVERAGE", "BIWEEKLY_CONSERVATIVE"]),
  includeP2P: z.coerce.boolean(),
});

export type SaveProfileState = { error?: string };

// Reuses the same updateGoalPosture/updateHouseholdSize/updateIncomeCalcMethod/
// setIncludeP2PInIncomeCalc actions Settings' household-profile-settings.tsx
// and income-calc-settings.tsx call — one implementation, no duplicated
// validation between the wizard and the editable-later Settings sections.
export async function saveProfileAndAdvance(
  _prev: SaveProfileState,
  formData: FormData,
): Promise<SaveProfileState> {
  const { user } = await requireOwner();

  const parsed = profileSchema.safeParse({
    goalPosture: formData.get("goalPosture"),
    adultsCount: formData.get("adultsCount"),
    kidsCount: formData.get("kidsCount"),
    incomeCalcMethod: formData.get("incomeCalcMethod"),
    includeP2P: formData.get("includeP2P") === "on",
  });
  if (!parsed.success) return { error: "Please fill in every field." };

  await updateGoalPosture(parsed.data.goalPosture);
  await updateHouseholdSize(parsed.data.adultsCount, parsed.data.kidsCount);
  await updateIncomeCalcMethod(parsed.data.incomeCalcMethod);
  await setIncludeP2PInIncomeCalc(parsed.data.includeP2P);
  await db.household.update({ where: { id: user.householdId }, data: { onboardingStep: "CONNECT" } });
  revalidateHousehold();
  return {};
}

const ADVANCEABLE_STEPS: OnboardingStep[] = ["PROFILE", "CONNECT", "REPORT", "BUCKETS", "DONE"];

export async function advanceOnboardingStep(step: OnboardingStep): Promise<void> {
  const { user } = await requireOwner();
  if (!ADVANCEABLE_STEPS.includes(step)) return;
  await db.household.update({ where: { id: user.householdId }, data: { onboardingStep: step } });
  revalidateHousehold();
}

const bucketSuggestionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  monthlyCapCents: z.number().int().min(0),
  trackingMode: z.enum(["SPEND", "RECURRING", "MIXED"]),
});

export type ConfirmBucketsState = { error?: string };

// Creates the buckets the household confirmed (re-entry safe: a no-op if
// buckets already exist — e.g. the wizard was restarted after already
// finishing this phase once, in which case `buckets` is just `[]` — the
// wizard's re-entry screen has nothing left to submit), then runs the same
// auto-categorization every SimpleFIN sync already runs, so whatever
// history exists gets sorted immediately instead of waiting for the next
// scheduled sync. Always marks onboarding complete on the way out, re-entry
// or not — this is the only place that does, so skipping it here is what
// used to strand a restarted household in a redirect loop back to /onboarding.
export async function confirmBucketsAndFinish(buckets: unknown): Promise<ConfirmBucketsState> {
  const { user } = await requireOwner();

  const existingCount = await db.bucket.count({ where: { householdId: user.householdId } });
  if (existingCount === 0) {
    const parsed = z.array(bucketSuggestionSchema).min(1).safeParse(buckets);
    if (!parsed.success) return { error: "Add at least one bucket." };

    await db.bucket.createMany({
      data: parsed.data.map((b, i) => ({
        householdId: user.householdId,
        name: b.name,
        monthlyCapCents: b.monthlyCapCents,
        trackingMode: b.trackingMode,
        sortOrder: i,
      })),
    });
    scheduleBucketIcons(user.householdId, { newName: true });
    await categorizeUncategorizedTransactions(user.householdId);
  }

  await db.household.update({
    where: { id: user.householdId },
    data: { onboardingCompletedAt: new Date(), onboardingStep: "DONE" },
  });
  revalidateHousehold();
  return {};
}
