"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Same collapsed-by-default convention as settings/ai/ai-usage-synopsis.tsx.
const STORAGE_KEY = "flow:settings-simplefin:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "Buckets & Transactions",
    description: (
      <>
        a budget-tracked checking/savings account&apos;s transactions feed the whole buckets pipeline the
        moment they sync in — categorization, merchant rules, spend totals, pace warnings. The wallet icon on
        a row marks which accounts are doing this.
      </>
    ),
  },
  {
    title: "Debts & the Payoff Plan",
    description: (
      <>
        linking a card or loan&apos;s own account is what lets Flow match its real payments, roll due dates
        forward, and compute minimums automatically instead of you entering them by hand — and it&apos;s
        required before that debt can receive cascaded extra payments from the payoff plan at all.
      </>
    ),
  },
  {
    title: "Net Worth",
    description: (
      <>
        a cash or investment account&apos;s synced balance counts toward Net Worth every sync unless
        you&apos;ve explicitly excluded it from the Net Worth page — no manual entry, no separate refresh.
      </>
    ),
  },
  {
    title: "Savings Goals",
    description: (
      <>
        an investment account linked to a goal reports its own real balance as that goal&apos;s progress —
        the goal tracks the account, not the other way around.
      </>
    ),
  },
];

export function AccountsUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How Your Connected Accounts Are Used"
      intro={
        <>
          A synced account doesn&apos;t automatically do anything on its own — it has to be linked to a
          Debt, Asset, or Savings Goal, or marked budget-tracked, before Flow treats its data as more than a
          balance sitting in the list below. The small icons on each row show which of those are actually
          switched on for it.
        </>
      }
      features={FEATURES}
    />
  );
}
