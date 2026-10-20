"use client";

import { ChevronDown } from "lucide-react";
import { useStoredBoolean } from "@/lib/use-stored-boolean";
import type { AiUsageSummary, AiUsageFeatureTotals } from "@/lib/ai-usage";

const STORAGE_KEY = "flow:settings-ai:usage-expanded";

// Feature ids as ai.ts tags each call (AiCallOptions.feature). An id not
// listed here still shows, just under its raw name.
const FEATURE_LABEL: Record<string, string> = {
  "receipt-extract": "Email Receipt Reading",
  "receipt-reclassify": "Receipt Re-Filing",
  "bucket-suggest": "Transaction Categorization",
  "category-suggest": "Bill Categories",
  "bill-category": "Bill Category",
  "keyword-match": "Keyword Matching",
  "p2p-classify": "P2P Payment Sorting",
  "routing-rule": "Routing Rules",
  "bucket-icons": "Bucket Icons",
  "monthly-report": "Monthly Report Narrative",
  "startup-report": "Startup Report",
  "budget-redraft": "Budget Redraft",
  "goal-feedback": "Savings Goal Feedback",
  "goal-plan": "Goal Planning Conversation",
  "asset-estimate": "Vehicle/Home Value Estimates",
  "bills-summary": "Bills Nudge",
};

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fmt = (n: number) => compact.format(n);
const totalTokens = (f: AiUsageFeatureTotals) => f.inputTokens + f.outputTokens + f.thinkingTokens;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

export function AiUsageCard({ summary }: { summary: AiUsageSummary }) {
  const [expanded, setExpanded] = useStoredBoolean(STORAGE_KEY, false);
  const calls = summary.features.reduce((s, f) => s + f.calls, 0);
  const tokens = summary.features.reduce((s, f) => s + totalTokens(f), 0);
  const sinceLabel = summary.windowLabel;

  return (
    <section className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-emerald-700 dark:text-emerald-400">AI Usage</h2>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-neutral-400">
            {calls === 0
              ? `No AI Calls · ${sinceLabel}`
              : `${plural(calls, "Call")} · ${fmt(tokens)} Tokens · ${sinceLabel}`}
          </p>
        </div>
        <ChevronDown
          size={18}
          className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {expanded && (
        <>
          {summary.features.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500 dark:text-neutral-400">
              Nothing has called your AI provider in this window.
            </p>
          ) : (
            <ul className="mt-3 flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
              {summary.features.map((f) => (
                <li key={f.feature} className="py-2 first:pt-0 last:pb-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate font-medium text-neutral-900 dark:text-neutral-100">
                      {FEATURE_LABEL[f.feature] ?? f.feature}
                    </span>
                    <span className="shrink-0 tabular-nums text-neutral-900 dark:text-neutral-100">
                      {fmt(totalTokens(f))} Tokens
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs tabular-nums text-gray-500 dark:text-neutral-400">
                    {plural(f.calls, "Call")}
                    {f.failed > 0 && <span className="text-amber-700 dark:text-amber-400"> ({f.failed} Failed)</span>}
                    {" · "}
                    {fmt(f.inputTokens)} In · {fmt(f.outputTokens)} Out · {fmt(f.thinkingTokens)} Thinking
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-gray-500 dark:text-neutral-400">
            Token counts are what your provider reported for each call. Output and thinking tokens bill at
            the output rate — check your provider&apos;s pricing for the dollar cost.
          </p>
        </>
      )}
    </section>
  );
}
