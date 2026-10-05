"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-household:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "Starter Budget Sizing",
    description: (
      <>
        the onboarding wizard scales its proposed grocery/dining/etc. caps to your adult and kid count when it
        builds a starter budget from your real spending history — a household of 4 gets a different grocery
        cap than a household of 1, before there&apos;s much history to go on.
      </>
    ),
  },
  {
    title: "Monthly Report Narrative",
    description: (
      <>
        your stated goal (pay down debt / build savings / balanced) and real debt numbers — total balance,
        minimums, and whatever extra you&apos;ve committed to paying — are given to the AI alongside this
        month&apos;s spend, so a budgeting nudge can be concrete: e.g. flagging that you&apos;re set to
        &quot;pay down debt&quot; but only covering minimums while money sits unused, or that you&apos;re
        &quot;building savings&quot; but goals are barely funded despite having room.
      </>
    ),
  },
  {
    title: "Savings Goal Feedback",
    description: (
      <>
        the weekly per-goal coaching weighs your stated goal against your actual debt load — if you&apos;ve
        said debt payoff is the priority, feedback leans toward keeping that first rather than pushing you to
        save harder toward a goal.
      </>
    ),
  },
  {
    title: "Savings Capacity",
    description: (
      <>
        the &quot;realistic savings capacity&quot; shown on a goal&apos;s page subtracts whatever extra
        you&apos;ve already committed to debt payoff (if the payoff plan is turned on) from what&apos;s left
        over — that cash is spoken for, not double-counted as available to save.
      </>
    ),
  },
];

export function HouseholdUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How Your Household Profile Is Used"
      intro={
        <>
          Your goal and household size aren&apos;t just cosmetic — alongside your actual spending and debt
          history, they&apos;re the two biggest inputs behind whether Flow steers a suggestion toward paying
          down debt or building savings.
        </>
      }
      features={FEATURES}
    />
  );
}
