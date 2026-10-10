"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Link2, ListPlus, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { dismissBnplSuggestion, createDebt } from "./actions";
import { showToast } from "@/lib/toast";
import { MerchantLogo } from "@/components/merchant-logo";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";
import { SelectField } from "@/components/select-field";
import { BucketCategoryFields } from "@/components/bucket-category-fields";
import { type CategoryOption } from "@/app/bills/category-picker";

// Linking a new institution only ever happens on SimpleFIN's own bridge site
// — our /settings/accounts page is just where an already-issued setup token
// gets pasted, and it dead-ends once a connection already exists. Send the
// user straight to the bridge instead of into that dead end.
const SIMPLEFIN_BRIDGE_URL = "https://bridge.simplefin.org";

export type BnplTransactionData = { id: string; merchant: string; amountCents: number; occurredOn: string };

export type BnplSuggestionData = {
  key: string;
  label: string;
  occurrences: number;
  lastAmountCents: number;
  lastSeen: string; // ISO date
  transactions: BnplTransactionData[];
};

// Best-effort default for "how many total payments" — most BNPL plans spell
// it out right in the merchant text ("Pay in 4"); if not, fall back to how
// many payments have already been seen. Either way the household can
// correct it before saving — they know their own plan terms best.
function guessTotalPayments(label: string, occurrences: number): number {
  const match = label.toLowerCase().match(/pay in (\d+)/);
  return match ? Number(match[1]) : occurrences;
}

const DAY_MS = 86_400_000;
type Cadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";

// Mirrors classifyCadence in src/lib/bill-detect.ts — not imported directly
// since that module (transitively, via db) pulls in the Prisma client, and
// this is a "use client" component (same reasoning as track-as-bill-form.tsx's
// defaultToleranceCents mirror). Only a starting guess for the cadence
// select below — most BNPL plans are every 2 weeks, and the household can
// always correct it.
function guessCadence(transactions: BnplTransactionData[]): Cadence {
  if (transactions.length < 2) return "BIWEEKLY";
  const sorted = [...transactions].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  const gaps = sorted
    .slice(1)
    .map((t, i) => (new Date(t.occurredOn).getTime() - new Date(sorted[i].occurredOn).getTime()) / DAY_MS);
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const maxDev = Math.max(...gaps.map((g) => Math.abs(g - avg)));
  if (avg >= 5 && avg <= 9 && maxDev <= 2) return "WEEKLY";
  if (avg >= 25 && avg <= 35 && maxDev <= 5) return "MONTHLY";
  if (avg >= 350 && avg <= 380 && maxDev <= 15) return "ANNUAL";
  return "BIWEEKLY"; // covers the classic 12-16 day band and anything unclear
}

// Earliest known transaction date — the best available guess for "when the
// plan started" (createDebt's purchaseDate anchors matchInstallmentPayments'
// backfill search there and no earlier).
function earliestDate(transactions: BnplTransactionData[]): string {
  return transactions.reduce((earliest, t) => (t.occurredOn < earliest ? t.occurredOn : earliest), transactions[0].occurredOn);
}

const FIELD_CLS =
  "rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs text-neutral-900 dark:text-neutral-100 focus:border-blue-900 focus:outline-none";
const FIELD_LABEL_CLS = "flex flex-col gap-1 text-xs text-amber-700 dark:text-amber-400";

type BucketOption = { id: string; name: string };

function TrackInstallmentForm({
  suggestion,
  buckets,
  defaultBucketId,
  categories,
  onDone,
}: {
  suggestion: BnplSuggestionData;
  buckets: BucketOption[];
  defaultBucketId: string | null;
  categories: CategoryOption[];
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cadence, setCadence] = useState<Cadence>(() => guessCadence(suggestion.transactions));
  const [bucketId, setBucketId] = useState(defaultBucketId ?? buckets[0]?.id ?? "");
  // Purely a visual pre-fill — the server defaults (and creates, on first
  // use) a "BNPL" category regardless, once this row's own resolvedCategoryId
  // logic in upsertInstallmentDebtPayment (debts/actions.ts) runs. This just
  // avoids showing "Uncategorized" in the picker for a category that's
  // about to be applied anyway.
  const bucketCategories = categories.filter((c) => c.bucketId === bucketId);
  const bnplCategoryId = bucketCategories.find((c) => c.name.toLowerCase() === "bnpl")?.id ?? null;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(async () => {
          const result = await createDebt({}, formData);
          if (result.error) {
            setError(result.error);
            return;
          }
          await dismissBnplSuggestion(suggestion.key);
          onDone();
          showToast("BNPL Plan Added");
        });
      }}
      className="mt-2 flex flex-col gap-2 border-t border-amber-200 dark:border-amber-900 pt-2"
    >
      <input type="hidden" name="debtType" value="INSTALLMENT" />
      <label className={FIELD_LABEL_CLS}>
        Name
        <input name="name" defaultValue={suggestion.label} required className={FIELD_CLS} />
      </label>
      <label className={FIELD_LABEL_CLS}>
        Label (optional — what was this actually for?)
        <input name="label" placeholder="e.g. Sarah's laptop" className={FIELD_CLS} />
      </label>
      <div className="flex gap-2">
        <label className={`flex-1 ${FIELD_LABEL_CLS}`}>
          Payment Amount
          <MoneyInput name="paymentAmount" defaultCents={suggestion.lastAmountCents} required className={FIELD_CLS} />
        </label>
        <label className={`w-20 ${FIELD_LABEL_CLS}`}>
          APR %
          <PercentInput name="apr" defaultPercent={0} required className={FIELD_CLS} />
        </label>
      </div>
      <label className={FIELD_LABEL_CLS}>
        Number of Payments
        <div className="relative">
          <input
            name="totalPayments"
            type="number"
            min={1}
            defaultValue={guessTotalPayments(suggestion.label, suggestion.occurrences)}
            required
            className={`w-full pr-16 ${FIELD_CLS}`}
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500">
            Payments
          </span>
        </div>
      </label>
      <div className="flex gap-2">
        <label className={`flex-1 ${FIELD_LABEL_CLS}`}>
          Cadence
          <SelectField
            name="cadence"
            value={cadence}
            onChange={(v) => setCadence(v as Cadence)}
            small
            searchable={false}
            options={[
              { value: "WEEKLY", label: "Weekly" },
              { value: "BIWEEKLY", label: "Every 2 Weeks" },
              { value: "MONTHLY", label: "Monthly" },
              { value: "ANNUAL", label: "Yearly" },
            ]}
          />
        </label>
        <label className={`flex-1 ${FIELD_LABEL_CLS}`}>
          Purchase Date
          <input
            name="purchaseDate"
            type="date"
            defaultValue={earliestDate(suggestion.transactions)}
            required
            className={FIELD_CLS}
          />
        </label>
      </div>
      <label className={FIELD_LABEL_CLS}>
        Amount Tolerance (optional — how much a payment can vary and still match)
        <MoneyInput name="tolerance" placeholder="Auto" className={FIELD_CLS} />
      </label>
      <BucketCategoryFields
        buckets={buckets}
        bucketId={bucketId}
        onBucketChange={setBucketId}
        categories={categories}
        defaultCategoryId={bnplCategoryId}
        small
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending || (buckets.length > 0 && !bucketId)}
        className="self-end rounded-lg bg-amber-600 dark:bg-amber-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : "Start Tracking"}
      </button>
    </form>
  );
}

function Card({
  suggestion,
  buckets,
  defaultBucketId,
  categories,
}: {
  suggestion: BnplSuggestionData;
  buckets: BucketOption[];
  defaultBucketId: string | null;
  categories: CategoryOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tracking, setTracking] = useState(false);

  if (gone) return null;

  return (
    <li className="rounded-lg border border-amber-300 dark:border-amber-800 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-neutral-400" />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-neutral-400" />
          )}
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium text-neutral-900 dark:text-neutral-100">
              <MerchantLogo merchant={suggestion.label} size={16} allowGuess />
              <span className="truncate">{suggestion.label}</span>
            </p>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {formatCents(suggestion.lastAmountCents)} last seen{" "}
              {formatDate(new Date(suggestion.lastSeen), { month: "short", day: "numeric" })} ·{" "}
              {suggestion.occurrences} payment{suggestion.occurrences === 1 ? "" : "s"} not connected
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() =>
              startTransition(async () => {
                await dismissBnplSuggestion(suggestion.key);
                setGone(true);
                showToast("Dismissed");
              })
            }
            disabled={pending}
            aria-label="Dismiss Suggestion"
            title="Dismiss"
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
          >
            <X size={14} />
          </button>
          <button
            onClick={() => setTracking((v) => !v)}
            aria-label={tracking ? "Close Installment-Plan Form" : "Track as an Installment Plan"}
            title={tracking ? "Close" : "Track as an Installment Plan (BNPL — Klarna, Affirm, Pay in 4, ...)"}
            className="rounded-lg border border-amber-600 dark:border-amber-700 p-1.5 text-amber-700 dark:text-amber-400"
          >
            <ListPlus size={14} />
          </button>
          <a
            href={SIMPLEFIN_BRIDGE_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Connect in SimpleFIN"
            title="Connect in SimpleFIN"
            className="rounded-lg bg-amber-600 dark:bg-amber-700 p-1.5 text-white"
          >
            <Link2 size={14} />
          </a>
        </div>
      </div>

      {expanded && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-amber-200 dark:border-amber-900 pt-2">
          {suggestion.transactions.map((t) => (
            <li key={t.id} className="flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400">
              <span className="flex items-center gap-1 truncate">
                  {formatDate(new Date(t.occurredOn), { month: "short", day: "numeric" })} ·{" "}
                  <MerchantLogo merchant={t.merchant} size={12} allowGuess />
                  {t.merchant}
                </span>
              <span className="shrink-0 font-medium text-neutral-800 dark:text-neutral-200">
                {formatCents(t.amountCents)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {tracking && (
        <TrackInstallmentForm
          suggestion={suggestion}
          buckets={buckets}
          defaultBucketId={defaultBucketId}
          categories={categories}
          onDone={() => setGone(true)}
        />
      )}
    </li>
  );
}

export function BnplSuggestions({
  suggestions,
  buckets,
  defaultBucketId,
  categories,
}: {
  suggestions: BnplSuggestionData[];
  buckets: BucketOption[];
  defaultBucketId: string | null;
  categories: CategoryOption[];
}) {
  if (suggestions.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
      <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
        Untracked Payments Detected
      </h2>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
        Payments to these lenders showed up in your bank feed, but they aren&apos;t connected. If
        it&apos;s a bank or card issuer, link it in SimpleFIN to track the balance automatically —
        but most BNPL plans (Klarna, Affirm, Pay in 4, ...) never offer a SimpleFIN feed at all, so
        use the list icon to track it as an installment plan instead: once its remaining payments
        hit zero, it&apos;s done — nothing keeps expecting a payment after the plan&apos;s actually
        over. Tap a card to see the matching transactions.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {suggestions.map((s) => (
          <Card key={s.key} suggestion={s} buckets={buckets} defaultBucketId={defaultBucketId} categories={categories} />
        ))}
      </ul>
    </div>
  );
}
