"use client";

import { UsageSynopsis } from "@/components/usage-synopsis";

// Collapsed by default for a first-time visitor, same convention as
// debts/total-debt-card.tsx's own STORAGE_KEY.
const STORAGE_KEY = "flow:settings-ai:synopsis-expanded";

const FEATURES: { title: string; description: React.ReactNode }[] = [
  {
    title: "Transaction Categorization",
    description: (
      <>
        when a synced merchant has no existing rule, batches every unmatched merchant from that sync into
        one suggestion call (bucket, transfer, income, or debt payment). Always just a pre-fill for the
        assign dropdown, never auto-applied — and once you confirm one, that merchant is remembered for
        every future transaction, so the same merchant is never asked about twice.
      </>
    ),
  },
  {
    title: "Monthly Report Narrative",
    description: (
      <>
        a short written summary comparing this month to last on the Reports page, cached per month-pair so
        it&apos;s not re-generated on every visit.
      </>
    ),
  },
  {
    title: "Savings Goal Feedback",
    description: (
      <>
        a weekly-cached take on a goal&apos;s progress, grounded in your real income, budget caps, and debt
        minimums — not a generic &quot;keep it up.&quot;
      </>
    ),
  },
  {
    title: "Goal Planning Conversation",
    description: (
      <>
        a back-and-forth chat when creating a savings goal from a plain description (&quot;a used car by
        next summer&quot;), which proposes a name/amount/date, ballparks the real total cost from general
        knowledge (tax, fees, closing costs, etc.), and pushes back honestly with a realistic alternative if
        the numbers don&apos;t work — never just agrees to be agreeable.
      </>
    ),
  },
  {
    title: "Vehicle/Home Value Estimates",
    description: (
      <>
        a general-knowledge ballpark for an asset&apos;s current value, refreshed monthly. There&apos;s no
        live pricing API behind this — it&apos;s explicitly framed as an estimate, not a quote.
      </>
    ),
  },
  {
    title: "Bills Nudge",
    description: (
      <>
        turns this week&apos;s bill list (name, amount, due date, paid status — already known, nothing
        looked up) into one plain-English sentence on the dashboard&apos;s bills card, e.g. &quot;Netflix and
        rent are still due this week — your gym membership already posted.&quot; A phrasing convenience more
        than real reasoning, cached once a day.
      </>
    ),
  },
];

export function AiUsageSynopsis() {
  return (
    <UsageSynopsis
      storageKey={STORAGE_KEY}
      title="How AI Is Used in Flow"
      intro={
        <>
          Every feature below is bring-your-own-key, off by default, and purely a nice-to-have layered on
          top of Flow&apos;s regular rule-based logic — a sync, a budget, or a goal works exactly the same
          with no provider configured. Nothing an AI feature produces is ever applied to your real data
          automatically; every suggestion still needs a tap to confirm.
        </>
      }
      features={FEATURES}
      outro={
        <>
          Every AI call fails open — a network blip, a rate limit, or no provider configured at all just
          means that one feature quietly sits out; nothing else in Flow depends on it working.
        </>
      }
    />
  );
}
