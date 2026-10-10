"use client";

import { useState, useTransition } from "react";
import { updateGoalPosture, updateHouseholdSize } from "../actions";
import { SelectField } from "@/components/select-field";
import { GOAL_POSTURE_OPTIONS } from "@/lib/goal-posture";
import { withToast } from "@/lib/toast";

const saved = (run: () => Promise<unknown>) => withToast(run, "Settings Saved");

type HouseholdGoalPosture = "DEBT_PAYDOWN" | "SAVINGS_FOCUSED" | "BALANCED";

// Same auto-save-on-change shape as IncomeCalcSettings — set once during the
// onboarding wizard, editable any time here. Feeds AI report/bucket-
// suggestion prompts (src/lib/ai.ts), not just cosmetic.
export function HouseholdProfileSettings({
  goalPosture,
  adultsCount,
  kidsCount,
}: {
  goalPosture: HouseholdGoalPosture;
  adultsCount: number;
  kidsCount: number;
}) {
  const [posture, setPosture] = useState<HouseholdGoalPosture>(goalPosture);
  const [adults, setAdults] = useState(adultsCount);
  const [kids, setKids] = useState(kidsCount);
  const [, startPostureTransition] = useTransition();
  const [, startSizeTransition] = useTransition();

  function commitSize() {
    const clampedAdults = Math.min(10, Math.max(1, Math.round(adults) || 1));
    const clampedKids = Math.min(10, Math.max(0, Math.round(kids) || 0));
    setAdults(clampedAdults);
    setKids(clampedKids);
    startSizeTransition(() => saved(() => updateHouseholdSize(clampedAdults, clampedKids)));
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-comfortaa text-emerald-700 dark:text-emerald-400">Primary Goal</span>
        <SelectField
          value={posture}
          onChange={(v) => {
            const next = v as HouseholdGoalPosture;
            setPosture(next);
            startPostureTransition(() => saved(() => updateGoalPosture(next)));
          }}
          searchable={false}
          options={GOAL_POSTURE_OPTIONS}
        />
        <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
          Shapes what AI reports and bucket suggestions steer you toward.
        </span>
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
          Adults in Household
          <input
            type="number"
            min={1}
            max={10}
            value={adults}
            onChange={(e) => setAdults(Number(e.target.value))}
            onBlur={commitSize}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
          Kids in Household
          <input
            type="number"
            min={0}
            max={10}
            value={kids}
            onChange={(e) => setKids(Number(e.target.value))}
            onBlur={commitSize}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal focus:border-blue-900 focus:outline-none"
          />
        </label>
      </div>
      <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
        Used to size realistic starter budgets (groceries, dining, etc.) before there&apos;s much spending history.
      </span>
    </div>
  );
}
