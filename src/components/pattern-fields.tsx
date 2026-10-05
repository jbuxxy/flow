"use client";

import { useState } from "react";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";
import { CADENCE_OPTIONS } from "@/lib/cadence-label";

const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

// The shared 4-cadence list plus this form's own leading "stay loose" option
// — no other field-order convention needs that option, so it's composed
// here rather than folded into the shared list.
const SCHEDULE_OPTIONS = [{ value: "", label: "No Real Schedule (Match on Amount Only)" }, ...CADENCE_OPTIONS];

export type PatternDefaults = {
  label?: string;
  channelKeyword?: string;
  // Unscheduled-pattern shape (no cadence) — a loose amount band, the only
  // identity signal available. Mutually exclusive with `amount` below.
  amountMin?: string;
  amountMax?: string;
  // Scheduled-pattern shape: one real amount + an optional tolerance,
  // exactly like RecurringBill's own Amount/Tolerance fields — no reason to
  // ask for a range once a tolerance already says how much it can vary
  // (household feedback, 2026-09-11).
  amount?: string;
  dayOfMonthStart?: string;
  dayOfMonthEnd?: string;
  weekdays?: number[];
  // "bucket:<id>" or "debt:<id>" — same combined-target shape the
  // Reclassify dropdown uses (transaction-row.tsx), so a target picked
  // there can carry straight over into a pattern without re-selecting it.
  target?: string;
  countsAsIncome?: boolean;
  billId?: string;
  categoryId?: string;
  // The receipt-resolved counterparty (Transaction.resolvedMerchant) off
  // whichever transaction triggered this form, when there is one — blank
  // for a household with no email connected, or one editing a pattern from
  // before this field existed. Still just a normal editable text field
  // either way (see RecurringPattern.counterpartyName's schema comment).
  counterpartyName?: string;
  // The triggering transaction's own receipt note, shown as context above
  // the noteKeywords input — not itself submitted.
  receiptNote?: string;
  noteKeywords?: string[];
  cadence?: string;
  nextDueDate?: string;
  tolerance?: string;
};

// Matches BillRow's own edit-form input sizing exactly (text-sm/py-2, not
// text-base/py-2.5) — this form predated that convention; brought in line
// 2026-09-11 (household: "review [the bill-row work] to improve this too").
const inputClass =
  "rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none";
const labelClass = "flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400";

// Shared by the inline "label this unlabeled transfer" flow
// (pattern-panel.tsx) and each pattern's edit panel (pattern-row.tsx) — one
// place for the amount/date/weekday inputs so both stay consistent.
export function PatternFields({
  buckets,
  debts = [],
  bills = [],
  categories = [],
  defaults,
  lockedChannelKeyword,
  lockedDirection,
}: {
  buckets: { id: string; name: string }[];
  debts?: { id: string; name: string }[];
  bills?: { id: string; name: string }[];
  categories?: CategoryOption[];
  defaults?: PatternDefaults;
  // Set when the caller already knows which app this is — from the
  // transaction that triggered the form (PatternPanel) or the pattern being
  // edited (PatternRow). Asking again would be asking the household to
  // retype something the merchant text already told us.
  lockedChannelKeyword?: string;
  // The transaction that triggered the form (or the pattern being edited)
  // already has a sign — it's obvious from that context, so we never ask.
  lockedDirection: "CREDIT" | "DEBIT";
}) {
  const [target, setTarget] = useState(defaults?.target ?? "");
  const [countsAsIncome, setCountsAsIncome] = useState(defaults?.countsAsIncome ?? true);
  const [billId, setBillId] = useState(defaults?.billId ?? "");
  const [cadence, setCadence] = useState(defaults?.cadence ?? "");

  return (
    <>
      <input
        name="label"
        defaultValue={defaults?.label}
        placeholder="Label (e.g. Dance, Haircuts)"
        required
        className={inputClass}
      />
      <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
        What to call this on statements — reused every time a transfer matches.
      </p>

      <input type="hidden" name="direction" value={lockedDirection} />

      {lockedChannelKeyword ? (
        <input type="hidden" name="channelKeyword" value={lockedChannelKeyword} />
      ) : (
        <>
          <input
            name="channelKeyword"
            defaultValue={defaults?.channelKeyword ?? "venmo"}
            placeholder="App (venmo, zelle, cash app)"
            required
            className={inputClass}
          />
          <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            Matched against the transaction description — lowercase, one word is enough.
          </p>
        </>
      )}

      {/* A real schedule types one Amount + an optional Tolerance, same
          line, same as BillRow's own Amount/Cadence/Due-Date row — a
          min/max range is redundant once a tolerance already says how much
          this can vary (household feedback, 2026-09-11). No real schedule
          keeps the original loose amount band, the only identity signal an
          unscheduled pattern has. */}
      {cadence ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={labelClass}>
            Amount
            <MoneyInput
              name="amount"
              defaultCents={defaults?.amount !== undefined ? Math.round(Number(defaults.amount) * 100) : undefined}
              required
              className={`mt-1 w-full ${inputClass}`}
            />
          </label>
          <label className={labelClass}>
            Tolerance (Optional)
            <MoneyInput
              name="tolerance"
              defaultCents={defaults?.tolerance ? Math.round(Number(defaults.tolerance) * 100) : undefined}
              placeholder="Auto"
              className={`mt-1 w-full ${inputClass}`}
            />
          </label>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <MoneyInput
              name="amountMin"
              defaultCents={defaults?.amountMin !== undefined ? Math.round(Number(defaults.amountMin) * 100) : undefined}
              placeholder="Min $"
              required
              className={`min-w-0 flex-1 ${inputClass}`}
            />
            <MoneyInput
              name="amountMax"
              defaultCents={defaults?.amountMax !== undefined ? Math.round(Number(defaults.amountMax) * 100) : undefined}
              placeholder="Max $"
              required
              className={`min-w-0 flex-1 ${inputClass}`}
            />
          </div>
          <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            A range, not an exact amount — wide enough to cover small variations between occurrences.
          </p>
        </>
      )}

      <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
        Who This Is With (Optional)
        <input
          name="counterpartyName"
          defaultValue={defaults?.counterpartyName}
          placeholder="e.g. Jane Doe"
          className={`mt-1 ${inputClass}`}
        />
      </label>
      <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
        {defaults?.counterpartyName
          ? "Pulled from a linked receipt — safe to edit. Only a payment to this specific person counts, not any similar-amount transfer."
          : "Filled in automatically once a receipt resolves who this went to/came from. Leave blank to match on amount alone, same as before."}
      </p>

      <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
        Tell Apart From a Similar Payment (Optional)
        <input
          name="noteKeywords"
          defaultValue={defaults?.noteKeywords?.join(", ")}
          placeholder="e.g. Alex, AJ"
          className={`mt-1 ${inputClass}`}
        />
      </label>
      <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
        {defaults?.receiptNote
          ? `The linked receipt's note reads "${defaults.receiptNote}" — list every name/word variant that should count (comma-separated) if this same person is paid for more than one thing (e.g. two kids' activities through the same coach).`
          : "Only matters if the same person is ever paid for more than one recurring thing — list a word from the payment note that's unique to this one."}
      </p>

      {/* Cadence + Next Due Date share one line, same size, once a real
          schedule is chosen — matches the Amount/Tolerance row above and
          BillRow's own Cadence/Due-Date pairing. Cadence sits alone (full
          width) while still unscheduled, since there's no due date yet to
          pair it with. */}
      {cadence ? (
        <div className="grid grid-cols-2 gap-2">
          <label className={labelClass}>
            Real Schedule
            <SelectField
              name="cadence"
              value={cadence}
              onChange={setCadence}
              searchable={false}
              options={SCHEDULE_OPTIONS}
              className="mt-1"
            />
          </label>
          <label className={labelClass}>
            Next Due Date
            <input
              name="nextDueDate"
              type="date"
              defaultValue={defaults?.nextDueDate}
              required
              className={`mt-1 ${inputClass}`}
            />
          </label>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          Real Schedule (Optional)
          <SelectField
            name="cadence"
            value={cadence}
            onChange={setCadence}
            searchable={false}
            options={SCHEDULE_OPTIONS}
            className="mt-1"
          />
        </label>
      )}
      {cadence && (
        <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          A real cadence + due date renders this like a bill — due/paid status, a per-cycle ledger, a running Total
          — instead of the plain rule list below.
        </p>
      )}

      {/* Only meaningful for an unscheduled pattern (no real cadence set
          above) — a scheduled one already has a precise nextDueDate driving
          which cycle a transaction belongs to, so this loose hint would be
          redundant at best. */}
      {!cadence && (
        <>
          <div className="flex gap-2">
            <input
              name="dayOfMonthStart"
              defaultValue={defaults?.dayOfMonthStart}
              placeholder="Day of month from"
              inputMode="numeric"
              className={`min-w-0 flex-1 ${inputClass}`}
            />
            <input
              name="dayOfMonthEnd"
              defaultValue={defaults?.dayOfMonthEnd}
              placeholder="to"
              inputMode="numeric"
              className={`min-w-0 flex-1 ${inputClass}`}
            />
          </div>

          <div className="flex flex-wrap gap-3 text-xs text-neutral-600 dark:text-neutral-400">
            {WEEKDAYS.map((w) => (
              <label key={w.value} className="flex items-center gap-1">
                <input type="checkbox" name="weekdays" value={w.value} defaultChecked={defaults?.weekdays?.includes(w.value)} />
                {w.label}
              </label>
            ))}
          </div>
          <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            Day range and weekdays are optional — only used to tell two similarly-priced
            patterns apart, never required for a match.
          </p>
        </>
      )}

      {lockedDirection === "DEBIT" ? (
        <SelectField
          name="target"
          value={target}
          onChange={setTarget}
          options={[
            { value: "", label: "Don't Count as Spending (Tag Only)" },
            ...buckets.map((b) => ({ value: `bucket:${b.id}`, label: b.name, group: "Bucket" })),
            ...debts.map((d) => ({ value: `debt:${d.id}`, label: d.name, group: "Debt Payment" })),
          ]}
          large
        />
      ) : (
        <>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="countsAsIncome"
              checked={countsAsIncome}
              onChange={(e) => setCountsAsIncome(e.target.checked)}
            />
            Count as household income (uncheck if this pays you back for something, like rent from a roommate)
          </label>
          {!countsAsIncome && bills.length > 0 && (
            <SelectField
              name="billId"
              value={billId}
              onChange={setBillId}
              options={[
                { value: "", label: "Doesn't Reimburse a Tracked Bill" },
                ...bills.map((b) => ({ value: b.id, label: b.name })),
              ]}
            />
          )}
          {!countsAsIncome && bills.length > 0 && billId && (
            <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
              Every matching credit auto-links to that cycle&apos;s bill payment — no need to link them by hand.
            </p>
          )}
        </>
      )}

      {/* DEBIT: scoped to whichever bucket is currently selected above (see
          the schema comment on BillCategory.bucketId) — a debt target or
          "tag only" has no bucket, so no category to pick either. CREDIT:
          no bucket concept at all (income/reimbursement) — shown as
          already-filtered by the caller (e.g. bill-row.tsx scopes a
          reimbursement pattern's list to its own bill's bucket), with "+
          New category" disabled here since there's no single bucket to
          scope a fresh one to. */}
      {lockedDirection === "DEBIT" ? (
        target.startsWith("bucket:") &&
        (() => {
          const targetBucketId = target.slice("bucket:".length);
          const scoped = categories.filter((c) => c.bucketId === targetBucketId);
          return (
            scoped.length > 0 && (
              <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                Category (Optional)
                <div className="mt-1">
                  <CategoryPicker
                    key={targetBucketId}
                    categories={scoped}
                    defaultCategoryId={defaults?.categoryId ?? null}
                    bucketId={targetBucketId}
                    name="categoryId"
                  />
                </div>
              </label>
            )
          );
        })()
      ) : billId ? (
        // A reimbursement pinned to a tracked bill never carries its own
        // category — it's the same spend the bill's own category already
        // describes, not a second, possibly-conflicting classification
        // (household feedback, 2026-09-11: "reimbursements shouldn't have a
        // category... it should just use the one for that [bill]"). No
        // field rendered at all, so nothing gets submitted — resolveCategoryId
        // enforces this same rule server-side too.
        <p className="-mt-2 text-xs text-neutral-400 dark:text-neutral-500">
          Uses the bill&apos;s own category — nothing to set here.
        </p>
      ) : (
        categories.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
            Category (optional)
            <div className="mt-1">
              <CategoryPicker categories={categories} defaultCategoryId={defaults?.categoryId ?? null} name="categoryId" />
            </div>
          </label>
        )
      )}
    </>
  );
}
