"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatISODate } from "@/lib/date";
import { guessBillCategoryLabel } from "@/lib/bill-category";
import { acceptBillSuggestion, dismissBillSuggestion } from "./actions";
import { showToast } from "@/lib/toast";
import { acceptDebtPaymentSuggestion } from "@/app/debts/actions";
import { CategoryPicker, type CategoryOption } from "./category-picker";
import { MerchantLogo } from "@/components/merchant-logo";
import { SelectField } from "@/components/select-field";

export type BillSuggestionData = {
  key: string;
  merchant: string;
  amountCents: number;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";
  nextDueDate: string; // ISO date
  lastSeenDate: string; // ISO date
  occurrences: number;
  transactionIds: string[];
  aiSuggestedBucketId: string | null;
  debtId: string | null;
  isCreditCard: boolean;
};

type BucketOption = { id: string; name: string };

const CADENCE_LABEL: Record<BillSuggestionData["cadence"], string> = {
  WEEKLY: "weekly",
  BIWEEKLY: "every 2 weeks",
  MONTHLY: "monthly",
  ANNUAL: "yearly",
};

// Best-effort starting guess only — resolved against the household's actual
// category list, which may have renamed or deleted any of the defaults.
// A credit-card debt payment guesses "Card payment" specifically so it
// doesn't collide with a plain "Loan payment" guess; if that category
// doesn't exist yet, this returns null and acceptBillSuggestion's
// find-or-create on the server fills the gap on first use.
function guessCategoryId(suggestion: BillSuggestionData, categories: CategoryOption[]): string | null {
  const label = suggestion.debtId
    ? suggestion.isCreditCard
      ? "Card payment"
      : "Loan payment"
    : guessBillCategoryLabel(suggestion.merchant);
  return categories.find((c) => c.name === label)?.id ?? null;
}

function Card({
  suggestion,
  buckets,
  categories,
}: {
  suggestion: BillSuggestionData;
  buckets: BucketOption[];
  categories: CategoryOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  const [bucketId, setBucketId] = useState(suggestion.aiSuggestedBucketId ?? buckets[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(guessCategoryId(suggestion, categories));

  if (gone) return null;

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate font-medium text-neutral-900 dark:text-neutral-100">
            <MerchantLogo merchant={suggestion.merchant} size={16} allowGuess />
            <span className="truncate">{suggestion.merchant}</span>
          </p>
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            {formatCents(suggestion.amountCents)} {CADENCE_LABEL[suggestion.cadence]} · seen{" "}
            {suggestion.occurrences}x, last {formatISODate(suggestion.lastSeenDate, { month: "short", day: "numeric" })}
            {suggestion.debtId ? " · toward this debt's balance" : ""}
          </p>
        </div>
        <button
          onClick={() =>
            startTransition(async () => {
              await dismissBillSuggestion(suggestion.key);
              setGone(true);
              showToast("Dismissed");
            })
          }
          disabled={pending}
          aria-label="Dismiss Suggestion"
          title="Dismiss"
          className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!suggestion.debtId && buckets.length > 1 && (
          <SelectField
            value={bucketId}
            onChange={setBucketId}
            disabled={buckets.length === 0}
            small
            placeholder="No Buckets Yet"
            options={buckets.map((b) => ({ value: b.id, label: b.name }))}
            className="min-w-0 flex-1"
          />
        )}
        <div className="w-40 shrink-0">
          {/* A debt suggestion has no bucket picker above (it always lands
              in defaultDebtPaymentBucketId's own bucket server-side, not
              this row's bucketId state) — showing the full list here for
              that case is a harmless fallback: acceptDebtPaymentSuggestion
              already validates/drops a wrong-bucket category and falls back
              to auto-creating "Card payment" in the right bucket instead
              (see resolveCategoryId's bucket check). */}
          <CategoryPicker
            key={suggestion.debtId ? "debt" : bucketId}
            categories={suggestion.debtId ? categories : categories.filter((c) => c.bucketId === bucketId)}
            defaultCategoryId={categoryId}
            bucketId={suggestion.debtId ? null : bucketId || null}
            onSelect={setCategoryId}
            small
          />
        </div>
        <button
          onClick={() =>
            startTransition(async () => {
              if (suggestion.debtId) {
                await acceptDebtPaymentSuggestion(
                  suggestion.key,
                  suggestion.debtId,
                  suggestion.amountCents,
                  suggestion.cadence,
                  categoryId,
                  suggestion.nextDueDate,
                  suggestion.transactionIds,
                  suggestion.isCreditCard,
                );
              } else {
                await acceptBillSuggestion(
                  suggestion.key,
                  suggestion.merchant,
                  suggestion.amountCents,
                  suggestion.cadence,
                  categoryId,
                  suggestion.nextDueDate,
                  suggestion.transactionIds,
                  bucketId || null,
                );
              }
              setGone(true);
              showToast("Now Tracking as Bill");
            })
          }
          disabled={pending || (!suggestion.debtId && !bucketId)}
          className="shrink-0 rounded-lg bg-emerald-700 dark:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "…" : "Track It"}
        </button>
      </div>
    </li>
  );
}

export function BillSuggestions({
  suggestions,
  buckets,
  categories,
}: {
  suggestions: BillSuggestionData[];
  buckets: BucketOption[];
  categories: CategoryOption[];
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4">
      <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">
        Looks Like Recurring Transactions
      </h2>
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
        Detected from your synced spending — pick a bucket and confirm to start tracking due
        dates automatically.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {suggestions.map((s) => (
          <Card key={s.key} suggestion={s} buckets={buckets} categories={categories} />
        ))}
      </ul>
    </div>
  );
}
