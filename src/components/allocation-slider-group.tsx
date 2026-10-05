"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { useStoredBoolean } from "@/lib/use-stored-boolean";
import type { BucketComposition, BudgetRecurringItem } from "@/lib/budget-plan";

// A constrained partition-slider group. Every slider draws from one shared
// pool, and each slider's own range is dynamic: [its floor, its current amount
// + whatever is still unallocated] (household request, 2026-10-02). Lowering
// one slider frees money, which immediately widens every other slider's
// range — so there's nothing to "cap" and no warning text; a slider simply
// can't be dragged past what exists. While a slider is being dragged its own
// max stays put (its drop is exactly the unallocated gain), and the others'
// tracks/thumbs glide to their new positions via a short CSS transition.
//
// The visible track/fill/thumb are plain divs layered under a transparent
// native <input type="range"> (sized via .alloc-range in globals.css so its
// thumb geometry matches the drawn one) — native keyboard (arrows /
// PageUp-Down / Home-End) and touch handling for free, custom look on top.
// RECURRING buckets render as a static line — their cap is a fixed bills total.

export type AllocationRow = {
  key: string;
  label: string;
  kind: "bucket" | "surplus" | "goal" | "newBucket";
  trackingMode?: "SPEND" | "RECURRING" | "MIXED";
  cents: number;
  minCents?: number;
  alternates?: { label: string; cents: number }[];
  rationale?: string;
  composition?: BucketComposition;
  recurringItems?: BudgetRecurringItem[];
};

export type LockedRow = { label: string; cents: number; hint?: string };

const STEP_CENTS = 100; // whole dollars — easier to read + manage
// Must match .alloc-range's thumb width in globals.css.
const THUMB_PX = 22;

const TRACKING_LABEL: Record<NonNullable<AllocationRow["trackingMode"]>, string> = {
  SPEND: "Spend",
  RECURRING: "Bills",
  MIXED: "Mixed",
};

const wholeDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

function TypeBadge({ mode }: { mode: NonNullable<AllocationRow["trackingMode"]> }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
      {TRACKING_LABEL[mode]}
    </span>
  );
}

// Same expand/collapse pattern as every collapsible card: the whole header is
// the button, ChevronDown on the right rotates, state remembered per row.
function Disclosure({
  storageKey,
  title,
  meta,
  children,
}: {
  storageKey: string;
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useStoredBoolean(storageKey, false);
  return (
    <div className="rounded-lg bg-neutral-50 dark:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span className="font-medium text-neutral-700 dark:text-neutral-300">{title}</span>
        {meta && <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">{meta}</span>}
        <ChevronDown
          size={14}
          className={`ml-auto shrink-0 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );
}

function RecurringCharges({ rowKey, items }: { rowKey: string; items: BudgetRecurringItem[] }) {
  if (items.length === 0) return null;
  const total = items.reduce((s, i) => s + i.cents, 0);
  return (
    <Disclosure
      storageKey={`budget-recurring:${rowKey}`}
      title="Expected Recurring Charges"
      meta={`${items.length} · ${formatCents(total)}`}
    >
      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <span className="min-w-0">
              <span className="block truncate text-neutral-800 dark:text-neutral-200">{item.label}</span>
              <span className="text-neutral-500 dark:text-neutral-400">
                {item.kind === "DEBT"
                  ? "Debt Payment"
                  : item.kind === "PATTERN"
                    ? `${item.channel ? item.channel.charAt(0).toUpperCase() + item.channel.slice(1) : "P2P"} Payment`
                    : "Bill"}
                {item.dueDate &&
                  ` · Due ${formatDate(new Date(`${item.dueDate}T00:00:00Z`), { month: "short", day: "numeric" })}`}
              </span>
              {(item.reimbursedCents ?? 0) > 0 && (
                <span className="block text-emerald-700 dark:text-emerald-400">
                  {formatCents(item.cents + item.reimbursedCents!)} − {formatCents(item.reimbursedCents!)} Expected Back
                </span>
              )}
            </span>
            <span className="shrink-0 tabular-nums font-medium text-neutral-800 dark:text-neutral-200">
              {formatCents(item.cents)}
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function CompositionDisclosure({ rowKey, c }: { rowKey: string; c: BucketComposition }) {
  if (c.topMerchants.length === 0) return null;
  const shown = c.topMerchants.slice(0, 2);
  const more = c.topMerchants.length - shown.length;
  const summary =
    shown.map((m) => `${m.merchant} ${wholeDollars(m.lastMonthCents)}`).join(" · ") + (more > 0 ? ` · +${more}` : "");
  return (
    <Disclosure storageKey={`budget-composition:${rowKey}`} title="Last Month" meta={summary}>
      <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {c.topMerchants.map((m) => (
          <li key={m.merchant} className="flex items-center justify-between gap-3 py-1.5 text-xs">
            <span className="min-w-0">
              <span className="block truncate text-neutral-800 dark:text-neutral-200">{m.merchant}</span>
              <span className="text-neutral-500 dark:text-neutral-400">
                ≈{formatCents(m.avgMonthlyCents)}/mo · {m.txnCount}× Over 4 Mo
              </span>
            </span>
            <span className="shrink-0 tabular-nums font-medium text-neutral-800 dark:text-neutral-200">
              {formatCents(m.lastMonthCents)}
            </span>
          </li>
        ))}
      </ul>
      {(c.topLabels.length > 0 || c.topCategories.length > 0) && (
        <div className="flex flex-wrap gap-1 pt-1.5">
          {[...c.topLabels, ...c.topCategories].map((t) => (
            <span key={t} className="rounded-full bg-neutral-200/70 dark:bg-neutral-800 px-2 py-0.5 text-[11px]">
              {t}
            </span>
          ))}
        </div>
      )}
    </Disclosure>
  );
}

// Controlled whole-dollar amount field. External changes (slider drag, chip
// click) flow back in via `cents`; the user's in-progress typing lives in
// local `draft` until blur / Enter, when it's committed through the same
// clamp the slider uses.
function AmountField({
  cents,
  onCommit,
  readOnly = false,
  label,
}: {
  cents: number;
  onCommit: (cents: number) => void;
  readOnly?: boolean;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const dollars = Math.round(cents / 100);
  const display = draft ?? `$${dollars.toLocaleString("en-US")}`;

  if (readOnly) {
    return <span className="shrink-0 text-right tabular-nums text-base font-semibold">{wholeDollars(cents)}</span>;
  }

  function commit() {
    if (draft === null) return;
    const digits = draft.replace(/[^\d]/g, "");
    setDraft(null);
    onCommit(digits ? parseInt(digits, 10) * 100 : 0);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        setDraft(String(dollars));
        requestAnimationFrame(() => e.target.select());
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      aria-label={`${label} Amount`}
      className="w-28 shrink-0 rounded-lg border border-transparent bg-neutral-100 px-2.5 py-1.5 text-right tabular-nums text-base font-semibold hover:border-neutral-300 focus:border-blue-700 focus:bg-transparent focus:outline-none dark:bg-neutral-900 dark:hover:border-neutral-700 dark:focus:border-blue-500"
    />
  );
}

function DynamicSlider({
  label,
  cents,
  min,
  max,
  dragging,
  onDragChange,
  onChange,
  readOnly,
  tone,
}: {
  label: string;
  cents: number;
  min: number;
  max: number;
  dragging: boolean;
  onDragChange: (dragging: boolean) => void;
  onChange: (cents: number) => void;
  readOnly: boolean;
  tone: "blue" | "emerald";
}) {
  const span = max - min;
  const frozen = span < STEP_CENTS; // nothing to move — floor and ceiling meet
  const pct = frozen ? 100 : Math.min(100, Math.max(0, ((cents - min) / span) * 100));
  // Native range thumbs travel from THUMB/2 to width−THUMB/2, not 0..100% —
  // offset the drawn thumb the same way so it sits exactly under the finger.
  const thumbLeft = `calc(${pct}% + ${(0.5 - pct / 100) * THUMB_PX}px)`;
  const motion = dragging ? "" : "transition-[left,width] duration-200 ease-out";
  const fill = tone === "emerald" ? "bg-emerald-600 dark:bg-emerald-500" : "bg-blue-700 dark:bg-blue-500";

  return (
    <div className="relative h-7">
      <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-neutral-200 dark:bg-neutral-800" />
      <div
        className={`absolute left-0 top-1/2 h-2 -translate-y-1/2 rounded-full ${fill} ${motion} ${frozen ? "opacity-40" : ""}`}
        style={{ width: thumbLeft }}
      />
      <div
        className={`pointer-events-none absolute top-1/2 h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-neutral-300 bg-white shadow-md dark:border-neutral-600 ${motion} ${
          dragging ? "scale-110" : ""
        } ${frozen || readOnly ? "opacity-60" : ""}`}
        style={{ left: thumbLeft }}
      />
      <input
        type="range"
        min={min}
        max={frozen ? min + STEP_CENTS : max}
        step={STEP_CENTS}
        value={frozen ? min + STEP_CENTS : Math.min(Math.max(cents, min), max)}
        aria-label={label}
        aria-valuetext={formatCents(cents)}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => onDragChange(true)}
        onPointerUp={() => onDragChange(false)}
        onPointerCancel={() => onDragChange(false)}
        onBlur={() => onDragChange(false)}
        disabled={readOnly || frozen}
        className="alloc-range absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function AllocationSliderGroup({
  poolCents,
  lockedRows,
  rows,
  unallocatedCents,
  onChange,
  readOnly = false,
}: {
  poolCents: number;
  lockedRows: LockedRow[];
  rows: AllocationRow[];
  // pool − Σ(locked) − Σ(rows), computed by the parent (which also needs it
  // for the confirm gate) and passed down so both stay in lockstep.
  unallocatedCents: number;
  onChange: (key: string, cents: number) => void;
  // Non-owner view: sliders, chips, and amount fields are inert.
  readOnly?: boolean;
}) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const free = Math.max(0, unallocatedCents);

  // Clamp to [floor, current + free] and snap to whole dollars. Typing or
  // tapping a chip for more than exists lands on the most that's available.
  function setRow(row: AllocationRow, requested: number) {
    if (readOnly) return;
    const min = row.minCents ?? 0;
    const ceiling = Math.max(min, row.cents + free);
    const snapped = Math.round(requested / STEP_CENTS) * STEP_CENTS;
    const next = Math.min(Math.max(snapped, min), ceiling);
    if (next !== row.cents) onChange(row.key, next);
  }

  const lockedSum = lockedRows.reduce((s, r) => s + r.cents, 0);
  const budgetedCents = poolCents - unallocatedCents;
  const pctOf = (c: number) => (poolCents > 0 ? Math.min(100, Math.max(0, (c / poolCents) * 100)) : 0);
  // Sliders move in whole dollars but a Bills cap carries cents, so the
  // partition can land a few cents either side of exact — under a dollar is
  // "every dollar assigned", never "over" (2026-10-02: "$0.47 Over" blocked
  // Confirm with nothing a slider could fix).
  const over = unallocatedCents <= -STEP_CENTS;

  return (
    <div className="flex flex-col gap-4">
      {/* Live total — moves with every slider. */}
      {/* Mobile: sits just under the sticky app header (its height is the
          safe-area-aware top padding + 1.75rem logo + 0.75rem bottom padding
          + 1px border, app-shell.tsx); desktop has no top header. */}
      <div className="sticky top-[calc(max(0.75rem,env(safe-area-inset-top))+2.5rem+1px)] z-10 -mx-4 -mt-1 border-b border-neutral-200 bg-[var(--background)]/95 px-4 pb-3 pt-2 backdrop-blur dark:border-neutral-800 lg:top-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Budgeted
          </span>
          <span className="tabular-nums">
            <span className={`text-xl font-semibold ${over ? "text-red-600 dark:text-red-400" : ""}`}>
              {wholeDollars(budgetedCents)}
            </span>
            <span className="text-sm text-neutral-500 dark:text-neutral-400"> of {wholeDollars(poolCents)}</span>
          </span>
        </div>
        <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          {lockedSum > 0 && (
            <div
              className="h-full bg-amber-500 transition-[width] duration-200 ease-out"
              style={{ width: `${pctOf(lockedSum)}%` }}
            />
          )}
          <div
            className={`h-full transition-[width] duration-200 ease-out ${over ? "bg-red-500" : "bg-blue-700 dark:bg-blue-500"}`}
            style={{ width: `${pctOf(budgetedCents - lockedSum)}%` }}
          />
        </div>
        <p
          className={`mt-1.5 text-xs font-medium ${
            over
              ? "text-red-600 dark:text-red-400"
              : unallocatedCents >= STEP_CENTS * 5
                ? "text-amber-700 dark:text-amber-400"
                : "text-emerald-700 dark:text-emerald-400"
          }`}
        >
          {over
            ? `${formatCents(-unallocatedCents)} Over — Lower A Slider`
            : unallocatedCents >= STEP_CENTS * 5
              ? `${formatCents(unallocatedCents)} Free To Assign · Goes To Surplus On Confirm`
              : "Every Dollar Assigned"}
        </p>
      </div>

      {lockedRows.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            <AlertTriangle size={12} />
            Not In A Bucket Yet
          </p>
          {lockedRows.map((r) => (
            <div key={r.label} className="flex items-center justify-between text-sm text-amber-800 dark:text-amber-300">
              <span className="flex items-center gap-1.5">
                {r.label}
                {r.hint && <span className="text-xs text-amber-600 dark:text-amber-500">· {r.hint}</span>}
              </span>
              <span className="tabular-nums">{formatCents(r.cents)}</span>
            </div>
          ))}
          <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
            This is reserved off the top of your income. Give each of these a bucket on{" "}
            <Link href="/debts" className="underline">
              Debts
            </Link>{" "}
            so a bucket cap covers it instead.
          </p>
        </div>
      )}

      <div className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
        {rows.map((row) => {
          const showBadge = (row.kind === "bucket" || row.kind === "newBucket") && row.trackingMode;
          const isStaticRecurring = row.kind === "bucket" && row.trackingMode === "RECURRING";
          const recurring = row.recurringItems ?? [];

          if (isStaticRecurring) {
            return (
              <div key={row.key} className="flex flex-col gap-2 py-4 first:pt-0">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">{row.label}</span>
                    <TypeBadge mode="RECURRING" />
                  </span>
                  <span className="shrink-0 tabular-nums text-base font-semibold">
                    {row.cents > 0 ? formatCents(row.cents) : "$0"}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
                  {row.cents > 0
                    ? row.rationale ?? "Fixed monthly bills — not adjustable here."
                    : "No bills scheduled this month."}
                </p>
                <RecurringCharges rowKey={row.key} items={recurring} />
              </div>
            );
          }

          const min = row.minCents ?? 0;
          const max = Math.max(min, row.cents + free);
          return (
            <div key={row.key} className="flex flex-col gap-2 py-4 first:pt-0">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold">{row.label}</span>
                  {row.kind === "surplus" && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                      Surplus
                    </span>
                  )}
                  {row.kind === "goal" && (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400">
                      Goal
                    </span>
                  )}
                  {showBadge && <TypeBadge mode={row.trackingMode!} />}
                </span>
                <AmountField cents={row.cents} onCommit={(c) => setRow(row, c)} readOnly={readOnly} label={row.label} />
              </div>

              <div>
                <DynamicSlider
                  label={row.label}
                  cents={row.cents}
                  min={min}
                  max={max}
                  dragging={draggingKey === row.key}
                  onDragChange={(d) => setDraggingKey(d ? row.key : null)}
                  onChange={(c) => setRow(row, c)}
                  readOnly={readOnly}
                  tone={row.kind === "surplus" || row.kind === "goal" ? "emerald" : "blue"}
                />
                <div className="mt-0.5 flex justify-between text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                  <span>{min > 0 ? `Min ${wholeDollars(min)}` : "$0"}</span>
                  <span>Up To {wholeDollars(max)}</span>
                </div>
              </div>

              {row.alternates && row.alternates.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {row.alternates.map((alt) => {
                    const active = Math.abs(alt.cents - row.cents) < STEP_CENTS;
                    const reachable = alt.cents <= max && alt.cents >= min;
                    return (
                      <button
                        key={alt.label}
                        type="button"
                        onClick={() => setRow(row, alt.cents)}
                        disabled={readOnly}
                        title={reachable ? undefined : "More Than Is Free Right Now — Lower Another Slider First"}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                          active
                            ? "bg-blue-900 text-white dark:bg-blue-700"
                            : reachable
                              ? "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
                              : "bg-neutral-100 text-neutral-400 dark:bg-neutral-900 dark:text-neutral-600"
                        }`}
                      >
                        {alt.label} <span className="tabular-nums">{wholeDollars(alt.cents)}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {row.rationale && (
                <p className="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{row.rationale}</p>
              )}
              {recurring.length > 0 && <RecurringCharges rowKey={row.key} items={recurring} />}
              {row.composition && <CompositionDisclosure rowKey={row.key} c={row.composition} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
