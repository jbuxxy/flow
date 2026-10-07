"use client";

import { useState, useTransition } from "react";
import { Calendar1, Check, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { acceptIncomeSuggestion, dismissIncomeSuggestion, markIncomeSuggestionOneOff } from "./actions";
import { showToast } from "@/lib/toast";
import { MerchantLogo } from "@/components/merchant-logo";

export type IncomeSuggestionData = {
  key: string;
  merchant: string;
  accountId: string;
  accountName: string;
  amountCents: number;
  cadence: "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY";
  nextPayDate: string; // ISO date
  occurrences: number;
  transactionIds: string[];
};

const CADENCE_LABEL: Record<IncomeSuggestionData["cadence"], string> = {
  BIWEEKLY: "every 2 weeks",
  SEMI_MONTHLY: "twice a month",
  MONTHLY: "monthly",
};

function Card({ suggestion }: { suggestion: IncomeSuggestionData }) {
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);

  if (gone) return null;

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-medium text-neutral-900 dark:text-neutral-100">
          <MerchantLogo merchant={suggestion.merchant} size={16} allowGuess />
          <span className="truncate">{suggestion.merchant}</span>
        </p>
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          {formatCents(suggestion.amountCents)} {CADENCE_LABEL[suggestion.cadence]} · {suggestion.accountName} ·{" "}
          seen {suggestion.occurrences}x
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() =>
            startTransition(async () => {
              await dismissIncomeSuggestion(suggestion.key);
              setGone(true);
              showToast("Dismissed");
            })
          }
          disabled={pending}
          aria-label="Dismiss Suggestion"
          title="Dismiss"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
        >
          <X size={16} />
        </button>
        <button
          onClick={() =>
            startTransition(async () => {
              await markIncomeSuggestionOneOff(suggestion.key, suggestion.transactionIds);
              setGone(true);
              showToast("Marked One-Time");
            })
          }
          disabled={pending}
          aria-label="Mark One-Time"
          title="One-Time: Counts Toward This Month, Not Projected Forward"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 disabled:opacity-50"
        >
          <Calendar1 size={16} />
        </button>
        <button
          onClick={() =>
            startTransition(async () => {
              await acceptIncomeSuggestion(
                suggestion.key,
                suggestion.merchant,
                suggestion.amountCents,
                suggestion.cadence,
                suggestion.nextPayDate,
                suggestion.accountId,
                suggestion.transactionIds,
              );
              setGone(true);
              showToast("Now Tracking Income");
            })
          }
          disabled={pending}
          aria-label="Add As Income"
          title="Add As Income"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-700 dark:bg-emerald-600 text-white disabled:opacity-50"
        >
          <Check size={16} />
        </button>
      </div>
    </li>
  );
}

export function IncomeSuggestions({ suggestions }: { suggestions: IncomeSuggestionData[] }) {
  if (suggestions.length === 0) return null;

  return (
    <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4">
      <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
        Looks Like Recurring Income
      </h2>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
        Detected from your synced deposits — confirm to start tracking automatically.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {suggestions.map((s) => (
          <Card key={s.key} suggestion={s} />
        ))}
      </ul>
    </div>
  );
}
