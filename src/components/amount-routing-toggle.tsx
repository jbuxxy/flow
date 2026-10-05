"use client";

import { MoneyInput } from "@/components/money-input";

// "under" routes charges at or below the threshold; "over" routes charges at
// or above it. Kept as a plain string union here (a pure UI concern) —
// merchant-rules.ts maps it to the stored [min, max] window server-side.
export type RoutingDirection = "under" | "over";

// The "only send this merchant here under/over $X" line that sits under the
// Move picker (both the /transactions row and a bucket page's Singles row).
// Purely presentational — the parent owns the checkbox/direction/amount state
// and fires setAmountRoutingRule from its existing Move button when `enabled`
// is set. Hidden entirely for P2P merchants (a bare "Venmo" rule is
// meaningless) and when the move isn't actually changing buckets.
export function AmountRoutingToggle({
  merchant,
  enabled,
  onEnabledChange,
  direction,
  onDirectionChange,
  amountDollars,
  onAmountDollarsChange,
}: {
  merchant: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  direction: RoutingDirection;
  onDirectionChange: (v: RoutingDirection) => void;
  // Seeds MoneyInput's initial value only (the parent sets it once from
  // suggestRoutingMax and never pushes a new value back down); edits flow
  // out through onAmountDollarsChange as a plain decimal string.
  amountDollars: string;
  onAmountDollarsChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500 dark:text-neutral-400">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
        className="accent-blue-700 dark:accent-blue-500"
      />
      <span>
        Only route <span className="font-medium text-neutral-700 dark:text-neutral-300">{merchant}</span> here
      </span>
      <select
        value={direction}
        onChange={(e) => onDirectionChange(e.target.value as RoutingDirection)}
        disabled={!enabled}
        aria-label={`Route ${merchant} here for charges over or under a dollar amount`}
        className="border-b border-neutral-300 dark:border-neutral-600 bg-transparent py-0.5 text-xs focus:border-blue-700 focus:outline-none disabled:opacity-40"
      >
        <option value="under">under</option>
        <option value="over">over</option>
      </select>
      <MoneyInput
        defaultCents={Math.round((parseFloat(amountDollars) || 0) * 100) || undefined}
        onValueChange={onAmountDollarsChange}
        disabled={!enabled}
        aria-label={`Route ${merchant} here only ${direction} this dollar amount`}
        className="w-20 border-b border-neutral-300 dark:border-neutral-600 bg-transparent py-0.5 text-center text-xs tabular-nums focus:border-blue-700 focus:outline-none disabled:opacity-40"
      />
    </label>
  );
}

// The "…and make this the rule for every <merchant> charge" line under the
// Move picker. Only shown when re-bucketing a transaction that was already
// filed somewhere (a first-time assignment teaches the rule on its own) and
// for a real, ruleable merchant (never P2P). Off by default: a plain Move is
// a one-transaction correction, not a household-wide rule change.
export function MakeRuleToggle({
  merchant,
  enabled,
  onEnabledChange,
}: {
  merchant: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
}) {
  return (
    <label className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500 dark:text-neutral-400">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
        className="accent-blue-700 dark:accent-blue-500"
      />
      <span>
        Also send every <span className="font-medium text-neutral-700 dark:text-neutral-300">{merchant}</span> charge here
        from now on
      </span>
    </label>
  );
}

// Next whole $5 up from a charge, floored at $10 — a sane starting guess for
// "purchases like this one" that the user then nudges.
export function suggestRoutingMax(amountCents: number): string {
  const dollars = Math.abs(amountCents) / 100;
  return String(Math.max(10, Math.ceil(dollars / 5) * 5));
}
