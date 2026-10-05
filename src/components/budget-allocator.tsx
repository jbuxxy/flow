"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, CalendarClock, PiggyBank, Compass, Lock, MessageSquare } from "lucide-react";
import { formatCents } from "@/lib/money";
import type { BudgetPlanAllocation } from "@/lib/budget-plan";
import {
  confirmBudgetPlanAction,
  dismissBudgetPlanAction,
  createSinkingFundAction,
  redraftBudgetPlanAction,
  clearBudgetRedraftAction,
} from "@/app/budget/actions";
import { describeRouteBand } from "@/lib/merchant-route";
import { showToast } from "@/lib/toast";
import { AllocationSliderGroup, type AllocationRow, type LockedRow } from "./allocation-slider-group";

const SURPLUS_KEY = "surplus";
const goalKey = (id: string) => `goal:${id}`;
const newKey = (name: string) => `new:${name}`;

function seed(allocation: BudgetPlanAllocation): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of allocation.buckets) m.set(b.bucketId, b.proposedCents);
  for (const g of allocation.savingsGoals) m.set(goalKey(g.goalId), g.proposedCents);
  m.set(SURPLUS_KEY, allocation.surplus.proposedCents);
  return m;
}

export function BudgetAllocator({
  allocation,
  readOnly = false,
}: {
  allocation: BudgetPlanAllocation;
  // Non-owner full-access member: sees the proposed plan, can't touch it.
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [amounts, setAmounts] = useState<Map<string, number>>(() => seed(allocation));
  const [checkedNew, setCheckedNew] = useState<Set<string>>(new Set());
  // Merchant-driven ideas the user has opted to auto-route (idea name) — starts
  // populated with every routable idea, toggled off per-idea.
  const [skipRoute, setSkipRoute] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dismissing, startDismiss] = useTransition();
  const [sinkingDone, setSinkingDone] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState(allocation.redraft?.instructions ?? "");
  const [redraftError, setRedraftError] = useState<string | null>(null);
  const [redrafting, startRedraft] = useTransition();

  // A merchant idea routes only while its toggle is on AND the household's
  // existing amount rules wouldn't shadow the route entirely.
  const isRouted = (nb: BudgetPlanAllocation["newBuckets"][number], skipped = skipRoute) =>
    !!nb.sourceMerchant && !nb.routeMovesNothing && !skipped.has(nb.name);
  const routeBand = (nb: BudgetPlanAllocation["newBuckets"][number]) =>
    nb.routeAmountMinCents != null && nb.routeAmountMaxCents != null
      ? { minCents: nb.routeAmountMinCents, maxCents: nb.routeAmountMaxCents }
      : null;

  function set(key: string, cents: number) {
    setAmounts((prev) => {
      const next = new Map(prev);
      next.set(key, cents);
      return next;
    });
  }

  function reset() {
    setAmounts(seed(allocation));
    setCheckedNew(new Set());
    setSkipRoute(new Set());
    setError(null);
  }

  const rows: AllocationRow[] = useMemo(() => {
    const out: AllocationRow[] = [];
    for (const b of allocation.buckets) {
      out.push({
        key: b.bucketId,
        label: b.name,
        kind: "bucket",
        trackingMode: b.trackingMode,
        cents: amounts.get(b.bucketId) ?? b.proposedCents,
        minCents: b.minCents,
        alternates: b.alternates,
        rationale: b.rationale,
        composition: b.composition,
        recurringItems: b.recurringItems,
      });
    }
    out.push({
      key: SURPLUS_KEY,
      label: "Surplus",
      kind: "surplus",
      cents: amounts.get(SURPLUS_KEY) ?? 0,
      rationale: allocation.surplus.rationale,
    });
    for (const g of allocation.savingsGoals) {
      out.push({
        key: goalKey(g.goalId),
        label: g.name,
        kind: "goal",
        cents: amounts.get(goalKey(g.goalId)) ?? 0,
        rationale: g.rationale,
      });
    }
    for (const nb of allocation.newBuckets) {
      if (!checkedNew.has(nb.name)) continue;
      out.push({
        key: newKey(nb.name),
        label: nb.name,
        kind: "newBucket",
        trackingMode: nb.trackingMode,
        cents: amounts.get(newKey(nb.name)) ?? 0,
        rationale: nb.rationale,
      });
    }
    return out;
  }, [allocation, amounts, checkedNew]);

  const lockedRows: LockedRow[] = allocation.lockedObligations;
  const lockedSum = lockedRows.reduce((s, r) => s + r.cents, 0);
  const allocatedSum = rows.reduce((s, r) => s + r.cents, 0);
  const unallocatedCents = allocation.poolCents - lockedSum - allocatedSum;
  const surplusAmount = amounts.get(SURPLUS_KEY) ?? 0;
  // Surplus after folding in whatever's still unallocated (the confirm step
  // sweeps the leftover into Surplus).
  const effectiveSurplus = surplusAmount + unallocatedCents;
  // Whole-dollar sliders vs. a cents-precise Bills cap can leave the
  // partition a few cents over — that's rounding, not overspending, so it
  // never blocks Confirm (the server's own balance check allows $10 of drift).
  const canConfirm = effectiveSurplus > -100;

  // The proposed surplus destinations (from goalPosture), scaled to whatever
  // surplus the sliders actually leave — the exact routing is finalized on
  // Confirm, this is the live preview.
  const surplusRows = useMemo(() => {
    // `destinations` is absent on old/pre-schema confirmed snapshots (the
    // example household still carries one) — treat a missing list as empty.
    const base = allocation.surplus.destinations ?? [];
    const baseSum = base.reduce((s, d) => s + d.cents, 0);
    if (baseSum <= 0 || effectiveSurplus <= 0) return [];
    const scale = effectiveSurplus / baseSum;
    return base.map((d) => ({ ...d, cents: Math.round(d.cents * scale) }));
  }, [allocation.surplus.destinations, effectiveSurplus]);

  // A merchant-route new bucket is funded by carving its cap straight out of
  // the bucket that merchant's spend lands in today (no net change to the plan
  // total). Only while the "route purchases here" toggle is on — without the
  // route, that spend still flows to the source bucket, so carving it would
  // just bust that bucket. Called from both the enable checkbox and the route
  // toggle so the two stay consistent.
  function syncCarve(
    nb: BudgetPlanAllocation["newBuckets"][number],
    opts: { checked: boolean; routed: boolean },
  ) {
    const srcRow = nb.sourceBucketId
      ? allocation.buckets.find((b) => b.bucketId === nb.sourceBucketId)
      : undefined;
    const current = amounts.get(newKey(nb.name)) ?? 0;
    const wantCarved = opts.checked && opts.routed && !!srcRow;
    if (wantCarved && srcRow) {
      const target = nb.carveFromSourceCents > 0 ? nb.carveFromSourceCents : nb.proposedCapCents;
      const delta = target - current; // >0 pull more from source, <0 give back
      const srcCurrent = amounts.get(srcRow.bucketId) ?? srcRow.proposedCents;
      const applied = Math.max(-current, Math.min(delta, srcCurrent - srcRow.minCents));
      set(srcRow.bucketId, srcCurrent - applied);
      set(newKey(nb.name), current + applied);
    } else if (srcRow && current > 0) {
      // Give whatever was carved back to the source bucket.
      set(srcRow.bucketId, (amounts.get(srcRow.bucketId) ?? srcRow.proposedCents) + current);
      set(newKey(nb.name), 0);
    } else if (opts.checked && !srcRow) {
      set(newKey(nb.name), Math.max(0, Math.min(nb.proposedCapCents, unallocatedCents)));
    } else {
      set(newKey(nb.name), 0);
    }
  }

  function toggleNew(nb: BudgetPlanAllocation["newBuckets"][number]) {
    const name = nb.name;
    setCheckedNew((prev) => {
      const next = new Set(prev);
      const nowChecked = !next.has(name);
      if (nowChecked) next.add(name);
      else next.delete(name);
      syncCarve(nb, { checked: nowChecked, routed: isRouted(nb) });
      return next;
    });
  }

  function confirm() {
    setError(null);
    const finalSurplus = Math.max(0, effectiveSurplus);
    startTransition(async () => {
      const res = await confirmBudgetPlanAction({
        periodKey: allocation.periodKey,
        buckets: allocation.buckets.map((b) => ({
          bucketId: b.bucketId,
          cents: amounts.get(b.bucketId) ?? b.proposedCents,
        })),
        newBuckets: [...checkedNew].map((name) => {
          const nb = allocation.newBuckets.find((x) => x.name === name)!;
          return {
            name,
            trackingMode: nb.trackingMode,
            capCents: amounts.get(newKey(name)) ?? 0,
            categories: nb.suggestedCategories,
            sourceMerchant: isRouted(nb) ? nb.sourceMerchant : null,
            sourceBucketId: isRouted(nb) ? nb.sourceBucketId : null,
          };
        }),
        surplusCents: finalSurplus,
        savingsGoalTargets: allocation.savingsGoals.map((g) => ({
          goalId: g.goalId,
          cents: amounts.get(goalKey(g.goalId)) ?? 0,
        })),
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      showToast("Budget Set");
      router.push("/");
    });
  }

  function redraft() {
    setRedraftError(null);
    startRedraft(async () => {
      const res = await redraftBudgetPlanAction(instructions);
      if (res.error) {
        setRedraftError(res.error);
        return;
      }
      showToast("Budget Redrafted");
      router.refresh();
    });
  }

  function clearRedraft() {
    setRedraftError(null);
    startRedraft(async () => {
      await clearBudgetRedraftAction();
      setInstructions("");
      showToast("Original Draft Restored");
      router.refresh();
    });
  }

  function dismiss() {
    startDismiss(async () => {
      await dismissBudgetPlanAction();
      showToast("Dismissed");
      router.push("/");
    });
  }

  function startSinkingFund(a: BudgetPlanAllocation["seasonalAlerts"][number]) {
    startTransition(async () => {
      const res = await createSinkingFundAction({
        name: a.sinkingFundName ?? a.title,
        monthlyCents: a.sinkingFundMonthlyCents ?? 0,
        targetMonth: a.sinkingFundTargetMonth,
      });
      if (!res.error) {
        setSinkingDone((prev) => new Set(prev).add(a.title));
        showToast("Sinking Fund Created");
        router.refresh();
      }
    });
  }

  // "Tell The AI What You Want" — one card, two homes: under the sliders on
  // mobile (review first, then ask for changes), and in the pinned left column
  // beside the AI Budget Coach on desktop, so it's always in reach while
  // scrolling the sliders. Same state either way.
  const instructionsCard = (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="mb-2 flex items-center gap-2">
        <MessageSquare size={15} className="text-blue-800 dark:text-blue-400" />
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Tell The AI What You Want</h2>
      </div>
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        maxLength={1000}
        rows={3}
        disabled={redrafting}
        placeholder="e.g. I want a Walmart bucket, but keep my rule sending Walmart orders $60 and up to Groceries."
        className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm disabled:opacity-60"
      />
      {redraftError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{redraftError}</p>}
      <div className="mt-2 flex items-center justify-end gap-3">
        {redrafting ? (
          <span className="text-xs text-gray-500 dark:text-neutral-400">Redrafting — Can Take Up To A Minute…</span>
        ) : (
          allocation.redraft && (
            <button
              type="button"
              onClick={clearRedraft}
              className="text-xs text-blue-900 dark:text-blue-300 underline decoration-dotted"
            >
              Restore Original Draft
            </button>
          )
        )}
        <button
          type="button"
          onClick={redraft}
          disabled={redrafting || instructions.trim().length === 0}
          className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Redraft Budget
        </button>
      </div>
    </div>
  );

  return (
    // Desktop: read-once context (coach, warnings, seasonal) in a narrow left
    // column; the interactive column (sliders + previews + confirm bar) gets
    // the wider `1fr` track. Mobile: `flex flex-col gap-5` stacks the left
    // column's children then the right column's — identical order to before.
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-6 lg:items-start">
    <div className="flex flex-col gap-5 lg:sticky lg:top-8 lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto">
      {readOnly && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm">
          <Lock size={15} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" />
          <p className="text-amber-800 dark:text-amber-300">
            <span className="font-medium">View Only.</span> This is the plan proposed for the month. Only the household
            owner can change bucket values or confirm the budget.
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-emerald-300 dark:border-emerald-800 bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-950/40 dark:to-blue-950/30 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles size={16} className="text-emerald-600 dark:text-emerald-400" />
          <h2 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">AI Budget Coach</h2>
        </div>
        <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
          {allocation.explanation}
        </p>
        <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
          {allocation.atBreakeven ? "You're at break even — this plan grows your surplus." : "Goal this month: get to break even."}
        </p>
      </div>

      {allocation.incomeEstimated && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm">
          <p className="font-medium text-amber-800 dark:text-amber-300">Working from estimated income</p>
          <p className="mt-1 text-gray-600 dark:text-neutral-400">
            This plan uses <span className="font-medium">{formatCents(allocation.poolCents)}/mo</span> estimated from your
            synced deposits. Confirm a paycheck on{" "}
            <Link href="/income" className="underline">Income</Link> to base it on your real number.
          </p>
        </div>
      )}

      {allocation.seasonalAlerts.length > 0 && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 p-4">
          <div className="mb-2 flex items-center gap-2">
            <CalendarClock size={16} className="text-amber-700 dark:text-amber-400" />
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">Seasonal Heads-Up</h2>
          </div>
          <div className="flex flex-col gap-3">
            {allocation.seasonalAlerts.map((a) => (
              <div key={a.title} className="text-sm">
                <p className="font-medium">{a.title}</p>
                <p className="text-gray-500 dark:text-neutral-400">{a.note}</p>
                {a.suggestSinkingFund && a.sinkingFundMonthlyCents && !readOnly ? (
                  sinkingDone.has(a.title) ? (
                    <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                      Sinking fund started — it&apos;ll show as its own slider next month.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startSinkingFund(a)}
                      disabled={pending}
                      className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-amber-400 dark:border-amber-700 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      <PiggyBank size={13} />
                      Start a Sinking Fund · {formatCents(a.sinkingFundMonthlyCents)}/mo
                    </button>
                  )
                ) : null}
              </div>
            ))}
          </div>
        </div>
      )}

      {!readOnly && <div className="hidden lg:block">{instructionsCard}</div>}
    </div>

    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
          {allocation.periodLabel} Allocation
        </h2>
        <AllocationSliderGroup
          poolCents={allocation.poolCents}
          lockedRows={lockedRows}
          rows={rows}
          unallocatedCents={unallocatedCents}
          onChange={set}
          readOnly={readOnly}
        />
      </div>

      {effectiveSurplus > 0 && (
        <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Compass size={15} className="text-blue-800 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Where Your Surplus Goes</h2>
          </div>
          {surplusRows.length > 0 && (
            <ul className="mb-2 flex flex-col gap-1.5">
              {surplusRows.map((r) => (
                <li key={r.label} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-neutral-800 dark:text-neutral-200">
                    {r.kind === "DEBT" ? `Extra Toward ${r.label}` : r.label}
                  </span>
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">
                    {formatCents(r.cents)}/mo
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
            {surplusRows.length > 0
              ? allocation.surplus.explanation
              : "This surplus follows your Primary Goal — it'll be routed to debt payoff or savings when you confirm."}
          </p>
          <p className="mt-1.5 text-xs text-gray-400 dark:text-neutral-500">
            Set by your{" "}
            <Link href="/settings/household" className="underline">
              Primary Goal
            </Link>
            {(allocation.surplus.direction === "DEBT" || allocation.surplus.direction === "SPLIT") && (
              <>
                {" · your payoff plan's extra per paycheck is set on "}
                <Link href="/debts" className="underline">
                  Debts
                </Link>{" "}
                and never changed here
              </>
            )}
            .
          </p>
        </div>
      )}

      {allocation.newBuckets.length > 0 && (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-900 p-4">
          <h2 className="mb-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">New Bucket Ideas</h2>
          <div className="flex flex-col gap-3">
            {allocation.newBuckets.map((nb) => (
              <div key={nb.name} className="flex flex-col gap-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checkedNew.has(nb.name)}
                    onChange={() => toggleNew(nb)}
                    disabled={readOnly}
                    className="accent-blue-700 dark:accent-blue-500 disabled:opacity-50"
                  />
                  <span className="font-medium">{nb.name}</span>
                  <span className="text-xs text-gray-500 dark:text-neutral-400">
                    {/* A routed idea's cap is what routing really moves (the
                        carve), not the AI's rough sizing — the slider uses the
                        carve, so the label must too (household report,
                        2026-10-02: listed $500, enabled at $1,037). */}
                    {formatCents(isRouted(nb) && nb.carveFromSourceCents > 0 ? nb.carveFromSourceCents : nb.proposedCapCents)}
                    /mo · {nb.trackingMode === "RECURRING" ? "Bills" : nb.trackingMode === "MIXED" ? "Mixed" : "Spend"}
                  </span>
                </label>
                <span className="pl-6 text-xs text-gray-500 dark:text-neutral-400">{nb.rationale}</span>
                {isRouted(nb) && nb.sourceBucketId && nb.carveFromSourceCents > 0 && (
                  <span className="pl-6 text-xs text-emerald-700 dark:text-emerald-400">
                    Moves ~{formatCents(nb.carveFromSourceCents)}/mo of {nb.sourceMerchant} spend out of{" "}
                    {allocation.buckets.find((b) => b.bucketId === nb.sourceBucketId)?.name ?? "its current bucket"} — your
                    total doesn&rsquo;t change
                  </span>
                )}
                {nb.sourceMerchant && nb.routeMovesNothing && (
                  <span className="pl-6 text-xs text-amber-700 dark:text-amber-400">
                    Your {nb.sourceMerchant} amount rules (
                    {(nb.existingAmountRules ?? [])
                      .map((r) => `${describeRouteBand(r)} → ${r.bucketName ?? "no bucket"}`)
                      .join(", ")}
                    ) already send every purchase elsewhere, so routing would move nothing. Tell the AI below which
                    purchases you want here.
                  </span>
                )}
                {nb.suggestedCategories.length > 0 && (
                  <span className="flex flex-wrap gap-1 pl-6">
                    {nb.suggestedCategories.map((c) => (
                      <span key={c} className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 text-xs">
                        {c}
                      </span>
                    ))}
                  </span>
                )}
                {nb.sourceMerchant && !nb.routeMovesNothing && checkedNew.has(nb.name) && (
                  <label className="flex items-center gap-2 pl-6 text-xs text-gray-600 dark:text-neutral-300">
                    <input
                      type="checkbox"
                      checked={!skipRoute.has(nb.name)}
                      onChange={() =>
                        setSkipRoute((prev) => {
                          const next = new Set(prev);
                          if (next.has(nb.name)) next.delete(nb.name);
                          else next.add(nb.name);
                          syncCarve(nb, { checked: checkedNew.has(nb.name), routed: isRouted(nb, next) });
                          return next;
                        })
                      }
                      className="accent-blue-700 dark:accent-blue-500"
                    />
                    {routeBand(nb)
                      ? `Route ${nb.sourceMerchant} purchases ${describeRouteBand(routeBand(nb)!)} into this bucket (moves past transactions too)`
                      : `Route ${nb.sourceMerchant}’s purchases into this bucket (moves past transactions too)`}
                  </label>
                )}
                {(() => {
                  // The household's other amount bands for this merchant stay
                  // exactly as they are — say so, so routing one band doesn't
                  // read as rerouting everything.
                  const others = (nb.existingAmountRules ?? []).filter(
                    (r) => r.minCents !== nb.routeAmountMinCents || r.maxCents !== nb.routeAmountMaxCents,
                  );
                  if (!nb.sourceMerchant || !routeBand(nb) || nb.routeMovesNothing || !checkedNew.has(nb.name)) return null;
                  if (others.length === 0) return null;
                  return (
                    <span className="pl-6 text-xs text-gray-500 dark:text-neutral-400">
                      Unchanged: {others.map((r) => `${describeRouteBand(r)} → ${r.bucketName ?? "no bucket"}`).join(", ")}
                    </span>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {!readOnly && <div className="lg:hidden">{instructionsCard}</div>}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {readOnly ? (
        <div className="sticky bottom-20 z-20 flex items-center gap-2 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-[var(--background)]/95 px-3 py-3 text-sm backdrop-blur lg:bottom-4">
          <Lock size={14} className="shrink-0 text-neutral-500" />
          <span className="text-neutral-600 dark:text-neutral-300">
            Only the household owner can confirm this budget.
          </span>
          <Link
            href="/"
            className="ml-auto rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
          >
            Back
          </Link>
        </div>
      ) : (
      <div className="sticky bottom-20 z-20 flex flex-col gap-2 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-[var(--background)]/95 px-3 py-3 backdrop-blur lg:bottom-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={dismiss}
            disabled={dismissing}
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm disabled:opacity-50"
          >
            {dismissing ? "…" : "Skip"}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending || !canConfirm}
            className="flex-1 rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Confirm Budget"}
          </button>
        </div>
      </div>
      )}
    </div>
    </div>
  );
}
