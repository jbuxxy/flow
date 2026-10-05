import type { SelectOption } from "@/components/select-field";

// Shared between the onboarding wizard's profile phase and Settings'
// household-profile-settings.tsx — same 3-way choice, same copy, both
// backed by the one updateGoalPosture action (src/app/settings/actions.ts).
export const GOAL_POSTURE_OPTIONS: SelectOption[] = [
  { value: "DEBT_PAYDOWN", label: "Pay down debt" },
  { value: "SAVINGS_FOCUSED", label: "Build savings" },
  { value: "BALANCED", label: "Balanced (a bit of both)" },
];

// Title Case short labels for the same three postures — for chrome that
// names the current/suggested goal (the Reports realignment card, the
// allocator's "Where Your Surplus Goes" card).
export const GOAL_POSTURE_LABEL: Record<string, string> = {
  DEBT_PAYDOWN: "Pay Down Debt",
  SAVINGS_FOCUSED: "Build Savings",
  BALANCED: "Balanced",
};
