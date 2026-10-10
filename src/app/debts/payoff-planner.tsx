"use client";

import { useActionState, useEffect, useMemo, useState, useTransition, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import type { BillCadence } from "@prisma/client";
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FlaskConical, List, Zap } from "lucide-react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  computeAttackOrder,
  simulatePayoff,
  projectCyclePlan,
  computeAlreadyFreedMinimums,
  pickPayoffPaymentTime,
  correctedNextDueDate,
  confirmProjectedExtras,
  type DebtInput,
  type PayoffOrder,
  type IncomeSchedule,
} from "@/lib/debt-payoff";
import { updateHouseholdPayoffPlan, setDebtPayoffOrder, type PayoffPlanState } from "./actions";
import { DebtRow, type CycleMinimum, type CycleExtra } from "./debt-row";
import { coveredMinimumDates, ledgerMinimumCents, minimumOwedCents } from "@/lib/minimum-ledger";
import { PayoffCycleCard } from "./payoff-cycle-card";
import { CycleCalendarView, type CalendarDayEvent } from "./cycle-calendar-view";
import { PayoffProjectionChart, PayoffProjectionSparkline } from "@/components/payoff-projection-chart";
import { useCollapsedState } from "@/components/collapsible-warning-card";
import { SelectField } from "@/components/select-field";
import { Switch } from "@/components/switch";
import { MoneyInput } from "@/components/money-input";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { useStoredBoolean } from "@/lib/use-stored-boolean";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";

// Remembers only expand/collapse (not any field value) — same pattern as
// TotalDebtCard's own storage key. Defaults to expanded, unlike TotalDebtCard
// (default collapsed): this box holds the actual editable controls, not a
// purely-informational chart, so a first-time visitor should see them.
const STRATEGY_STORAGE_KEY = "flow:debts:strategy-expanded";

export type PlannerDebt = DebtInput & {
  debtType: "REVOLVING" | "INSTALLMENT";
  kind: "CARD" | "LOAN" | "BNPL";
  // The household's own free-text note for this debt ("Sam's Kobes") — see
  // Debt.label. Shown inline after the name on the row, same as DebtPaymentCard.
  label: string | null;
  installmentsTotal: number | null;
  installmentsRemaining: number | null;
  // Debt.freedMinimumCents — the last real minimum a paid-off debt carried,
  // rolled into the plan once its own minimum reads $0 (freedMinimumOf).
  freedMinimumCents?: number | null;
  // Itemization from the email receipt for the original BNPL purchase, once
  // one's been linked to this plan (Receipt.debtId / linkReceiptToPlan).
  receiptItems: { description: string; qty: number | null; unitPriceCents: number | null; totalCents: number | null }[] | null;
  receiptTotalCents: number | null;
  source: "MANUAL" | "SIMPLEFIN";
  accountId: string | null;
  paidOffDate: Date | null;
  // The balance right before that same >0 -> 0 transition (see
  // nextPaidOffAmountCents, debt-payoff.ts) — the amount for the paidOffDate
  // fallback lines below, when there's no linked transaction/snapshot to
  // read a real dollar figure from yet.
  paidOffAmountCents: number | null;
  includeInPayoffPlan: boolean;
  // A household's "stop showing me this" call — see Debt.hiddenAt in
  // schema.prisma. Filtered out of activeDebts/notInPlanDebts/paidOffDebts/
  // trailingDebts below so hiding actually removes the card from this page
  // too, not just Account Settings. A hidden still-owed debt therefore also
  // drops out of the payoff simulation (attack order, debt-free date) it
  // would otherwise feed via activeDebts — deliberate: a debt you can't see
  // here shouldn't silently keep steering a plan you also can't see it in.
  // A hidden *paid-off* debt is unaffected by this either way (it was never
  // in activeDebts to begin with) and still contributes to
  // alreadyFreedMinimums below exactly as before hiding existed.
  hiddenAt: Date | null;
  suggestedAccount: { id: string; name: string } | null;
  needsSetup: boolean;
  patternCount: number;
  cycleMinimum: CycleMinimum | null;
  // The same ledger for last calendar month — the "Last Month" list page
  // (see debts/page.tsx). Optional: other callers don't page backward.
  lastMonthCycleMinimum?: CycleMinimum | null;
  // The raw synced account name and its institution name, distinct from
  // `name` above (which already prefers a household's own renamed
  // Account.displayName) — see debts/page.tsx's own comment on this same
  // field. DebtRow's logo matching also searches these. Never shown as
  // text; null for a manual (unlinked) debt.
  accountRawName: string | null;
  accountOrgName: string | null;
};

const initialSaveState: PayoffPlanState = {};

// One read on whether this plan's extra payments are wired into the rest of
// the app (Household.payoffPlanEnabled) — "on" means they count as real
// upcoming spending (dashboard "This Week's Bills", next month's budget
// projection); "off" means this page is a sandbox. Shared by the collapsed
// Payoff Strategy summary and the Payoff Calendar header so the same state
// reads identically in both places.
function PlanBudgetBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      title={
        enabled
          ? "This plan's extra payments count as real upcoming spending in your budget and dashboard."
          : "Projection only — nothing on this page affects your budget. Turn on “Feed This Plan Into Budgeting” to apply it."
      }
      className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        enabled
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
          : "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${enabled ? "bg-emerald-500" : "bg-neutral-400 dark:bg-neutral-500"}`} />
      {enabled ? "On" : "Off"}
    </span>
  );
}

export function PayoffPlanner({
  debts,
  initialOrder,
  initialExtraDollars,
  initialRollFreedMinimums,
  initialRollFreedMinimumsSplit,
  initialEnabled,
  income,
  isOwner,
  payoffExtraSkips,
  payoffSnapshots,
  supersededPayoffExtraByDebtId,
  todayISO,
  totalDebtCard,
}: {
  debts: PlannerDebt[];
  initialOrder: PayoffOrder;
  initialExtraDollars: number;
  initialRollFreedMinimums: boolean;
  initialRollFreedMinimumsSplit: boolean;
  initialEnabled: boolean;
  income: IncomeSchedule | null;
  // Non-owner full-access member (2026-08-21) — the whole plan (calendar,
  // projection, per-debt cards) stays visible/informative, but nothing here
  // is editable for them: no strategy form, no drag-reorder, no per-debt
  // link/mark-paid actions (see DebtRow's own readOnly). The underlying
  // server actions already enforce this (requireOwner, ./actions) — this
  // prop just keeps the UI from offering controls that would only redirect.
  isOwner: boolean;
  // Every household-skipped (debt, payday) pair still within reach of the
  // current cycle — see debts/page.tsx and src/lib/debt-payments.ts's
  // getPayoffExtraSkips. paycheckDate is a plain YYYY-MM-DD string (already
  // serialized server-side) so this stays a plain prop across the server/
  // client boundary. amountCents/isPayoff are frozen at the moment the
  // household skipped it (null only for a pre-fix row skipped before this
  // existed) — overridden onto the live-simulated line below instead of
  // trusting projectCyclePlan's own re-derived amount for it, which drifts
  // once the debt roster/priority order changes after the skip (see the
  // schema comment on PayoffExtraSkip.amountCents).
  payoffExtraSkips: { debtId: string; paycheckDate: string; amountCents: number | null; isPayoff: boolean | null }[];
  // Every isPayoff PayoffExtraSnapshot row (src/lib/debt-payments.ts) whose
  // dueDate falls in this month or last — the plan's own recorded "this is
  // when the extra was expected to close it" date, spanning both calendar
  // pages this component renders. Preferred over Debt.paidOffDate for the
  // payoff-only fallback line below: paidOffDate is just whenever a balance
  // sync happened to notice $0, which routinely lands well after the
  // household actually expected the payoff (real report, 2026-09-07: Sam's
  // Club Card's plan expected Sep 3 — the same date "Last Week's Bills"
  // already shows — but the balance sync didn't confirm it until Sep 7).
  payoffSnapshots: { debtId: string; dueDate: string; amountCents: number }[];
  // Per-debt real extra money this month that already went toward a payoff
  // target the live plan no longer projects — subtracted before
  // thisCycleExtrasByDebtId confirms anything. Resolved server-side (see
  // supersededPayoffExtraCents, @/lib/debt-payoff, and debts/page.tsx) because
  // it reads PayoffExtraSnapshot.weekStart, which never crosses to the client.
  supersededPayoffExtraByDebtId: Record<string, number>;
  // Server-computed "today" (todayAsUTCDate, @/lib/date), YYYY-MM-DD — passed
  // straight through to every DebtRow (see its own comment on this prop for
  // why it isn't just read via `new Date()` client-side).
  todayISO: string;
  // The already-built <TotalDebtCard/>, rendered by page.tsx (it needs
  // server-fetched `debts`/`trend` this component doesn't have) but placed
  // here so it can sit in the same desktop grid as the Payoff Strategy card
  // below — see the render's own comment on why they're paired.
  totalDebtCard: React.ReactNode;
}) {
  const [saveState, saveAction, savePending] = useActionState(updateHouseholdPayoffPlan, initialSaveState);
  const [, startOrderSaveTransition] = useTransition();
  const router = useRouter();

  // Every simulation on this page (cyclePlan, result, calendar, …) is
  // recomputed live from the `debts`/`income` props via useMemo — so it's
  // already exactly as fresh as those props are. Every action taken *on
  // this page* (save plan, drag reorder, mark paid, link account, …)
  // already revalidates and picks up fresh props for free. The gap is
  // balance changes that happen with no action on this page at all — a
  // SimpleFIN sync (runs on its own 20-minute server-side timer, see
  // instrumentation.ts) noticing a new purchase, an unexpected payment, or
  // a refund while this tab just sits open in the background. Next.js
  // doesn't push server-side changes into an already-mounted page on its
  // own, so refetch whenever the tab becomes visible again — cheap, and
  // catches the realistic case (household steps away, comes back) without
  // constant polling.
  useEffect(() => {
    function refreshIfVisible() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [router]);

  const [orderMode, setOrderMode] = useState<PayoffOrder>(initialOrder);
  const [extraDollars, setExtraDollars] = useState(String(initialExtraDollars));
  const [rollFreedMinimums, setRollFreedMinimums] = useState(initialRollFreedMinimums);
  const [rollFreedMinimumsSplit, setRollFreedMinimumsSplit] = useState(initialRollFreedMinimumsSplit);
  const [enabled, setEnabled] = useState(initialEnabled);

  // The strategy form recomputes every projection on this page live from the
  // state above — so "Save Plan" never changes anything visible here and used
  // to feel like a no-op. Gate the button on an actual diff against the
  // last-saved values (the `initial*` props, which refresh after a successful
  // save via revalidatePath) and flash a "Saved" confirmation on the way out.
  const isDirty =
    orderMode !== initialOrder ||
    Math.round((Number(extraDollars) || 0) * 100) !== Math.round(initialExtraDollars * 100) ||
    rollFreedMinimums !== initialRollFreedMinimums ||
    rollFreedMinimumsSplit !== initialRollFreedMinimumsSplit ||
    enabled !== initialEnabled;

  // Fires the "Payoff Plan Saved" toast and drives the inline "Saved" flash
  // (below) off the same pending→done edge.
  const { justSaved } = useActionToast(savePending, saveState, { success: "Payoff Plan Saved" });

  const [strategyExpanded, setStrategyExpanded] = useStoredBoolean(STRATEGY_STORAGE_KEY, true);
  function toggleStrategy() {
    setStrategyExpanded(!strategyExpanded);
  }

  const [projectedPayoffCollapsed, setProjectedPayoffCollapsed] = useCollapsedState("projected-payoff");

  const activeDebts = useMemo(
    () => debts.filter((d) => d.balanceCents > 0 && d.includeInPayoffPlan && !d.hiddenAt),
    [debts],
  );
  const trailingDebts = useMemo(
    () => debts.filter((d) => !(d.balanceCents > 0 && d.includeInPayoffPlan) && !d.hiddenAt),
    [debts],
  );
  // Still owed, but the household excluded it from the attack order
  // (Debt.includeInPayoffPlan false) — no numbered priority badge, so it
  // reads as excluded without needing its own section header. Alphabetical,
  // not attack-order, since these were never ordered to begin with.
  const notInPlanDebts = useMemo(
    () =>
      debts
        .filter((d) => d.balanceCents > 0 && !d.includeInPayoffPlan && !d.hiddenAt)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [debts],
  );
  // Fully paid off (any includeInPayoffPlan value) — always last, alphabetical.
  const paidOffDebts = useMemo(
    () => debts.filter((d) => d.balanceCents <= 0 && !d.hiddenAt).sort((a, b) => a.name.localeCompare(b.name)),
    [debts],
  );
  // Minimum-payment dollars already freed by debts that are paid off
  // (balanceCents 0) — minPaymentCents survives on a debt even after it
  // hits $0 (see manual-debt-editor.tsx), so this is the same "take the
  // minimum from paid-off cards" pool the household configures via "Roll
  // freed-up minimums into the next debt." Without this, only a debt that
  // gets paid off *during* one of these simulations ever contributes its
  // freed minimum — one already paid off before "now" is filtered out of
  // activeDebts entirely and would otherwise never count.
  // Shares its filter/sort/freedMonthKey math with the server-side
  // getAlreadyFreedMinimums (debt-payments.ts) via computeAlreadyFreedMinimums
  // — see that function's own comment for why (the two had drifted apart
  // before). This client copy exists at all only so the live preview updates
  // instantly as the household edits order/extra/roll toggle, before ever
  // hitting "Save plan"; it runs on data already on the page rather than
  // querying the DB again.
  const alreadyFreedMinimums = useMemo(
    () => computeAlreadyFreedMinimums(debts.map((d) => ({ ...d, paymentCadence: d.cycleMinimum?.cadence }))),
    [debts],
  );
  const [customOrderIds, setCustomOrderIds] = useState<string[]>(() => activeDebts.map((d) => d.id));

  // The live attack order — recomputed on every render from local state, so
  // strategy/extra/roll/order changes are reflected immediately, before
  // "Save plan" is ever clicked.
  const orderedActiveDebtIds = useMemo(() => {
    if (orderMode !== "CUSTOM") return computeAttackOrder(activeDebts, orderMode);
    const activeIdSet = new Set(activeDebts.map((d) => d.id));
    const kept = customOrderIds.filter((id) => activeIdSet.has(id));
    const missing = activeDebts.map((d) => d.id).filter((id) => !kept.includes(id));
    return [...kept, ...missing];
  }, [orderMode, customOrderIds, activeDebts]);
  // The "Last Month" list page: same order as This Month's list (attack
  // order, then not-in-plan, then paid off), keeping only debts that had a
  // due date or a payment last month.
  const lastMonthListDebts = useMemo(
    () =>
      [
        ...orderedActiveDebtIds.map((id) => activeDebts.find((d) => d.id === id)!),
        ...notInPlanDebts,
        ...paidOffDebts,
      ].filter((d) => {
        const lm = d.lastMonthCycleMinimum;
        return lm != null && (lm.slots.length > 0 || lm.extraPayments.length > 0);
      }),
    [orderedActiveDebtIds, activeDebts, notInPlanDebts, paidOffDebts],
  );

  // Attaches each debt's real billing cadence (DebtInput.paymentCadence) —
  // without it, monthlyEquivalentCents falls back to assuming MONTHLY,
  // which is wrong for a WEEKLY/BIWEEKLY BNPL plan (see that function's own
  // comment in debt-payoff.ts).
  const toDebtInput = (d: PlannerDebt): DebtInput => ({
    ...d,
    paymentCadence: d.cycleMinimum?.cadence,
    // INSTALLMENT payoff projection bills each installment on its real
    // cadence schedule (see simulatePayoff / monthlyMinimumDue) — needs the
    // next unpaid installment's date and how many are left.
    nextDueDate: d.cycleMinimum?.nextDueDate ?? null,
    installmentsRemaining: d.installmentsRemaining,
  });

  const debtInputs: DebtInput[] = useMemo(
    () => orderedActiveDebtIds.map((id) => toDebtInput(activeDebts.find((d) => d.id === id)!)),
    [orderedActiveDebtIds, activeDebts],
  );
  const attackOrder = useMemo(() => computeAttackOrder(debtInputs, orderMode), [debtInputs, orderMode]);
  const attackOrderIndexById = useMemo(() => new Map(attackOrder.map((id, i) => [id, i])), [attackOrder]);

  // Every still-owed debt, in-plan or not — the "Projected Payoff" section
  // (chart + debt-free date) is meant to answer "when is the household
  // actually debt-free," which depends on every balance, not just the ones
  // the attack order is allowed to throw extra money at. Appended after
  // debtInputs (order doesn't matter for these — see extraEligibleIds below,
  // they never receive cascaded extra payments, only their own minimum).
  const projectionDebtInputs: DebtInput[] = useMemo(
    () => [...debtInputs, ...notInPlanDebts.map(toDebtInput)],
    [debtInputs, notInPlanDebts],
  );
  const inPlanIds = useMemo(() => new Set(debtInputs.map((d) => d.id)), [debtInputs]);

  const extraPerPaycheckCents = Math.round((Number(extraDollars) || 0) * 100);
  const minimumOnly = extraPerPaycheckCents === 0 && !rollFreedMinimums;

  // Shown in place of the full form while collapsed — enough to tell at a
  // glance what's configured without expanding.
  const orderLabel = orderMode === "AVALANCHE" ? "Avalanche" : orderMode === "SNOWBALL" ? "Snowball" : "Custom Order";
  const strategySummary = minimumOnly
    ? "Minimums Only — No Extra Payments"
    : `${orderLabel} · +${formatCents(extraPerPaycheckCents)}/paycheck${
        rollFreedMinimums ? (rollFreedMinimumsSplit ? ", rolling minimums" : ", rolling minimums (lump)") : ""
      }`;

  // Which debts' current-cycle minimum is already satisfied per the real
  // ledger — projectCyclePlan needs this to know whether to fold this
  // cycle's still-pending minimum (+ its interest) into the balance it
  // carries forward into next cycle, without double-counting one that's
  // already reflected in the live balanceCents it started from. simulatePayoff
  // below needs the exact same thing for the exact same reason — its own
  // month-1 tick starts from that same live balanceCents (real report,
  // 2026-09-14: Amazon Card's already-posted $35 minimum got double-counted
  // by the "Projected Payoff" chart, which had never received this set,
  // showing a payoff month earlier than the Payoff Calendar's own — correct —
  // projectCyclePlan projection just below).
  const minimumSatisfiedThisCycleIds = useMemo(
    () => new Set(debts.filter((d) => d.cycleMinimum?.paidThisCycle).map((d) => d.id)),
    [debts],
  );
  // Household-skipped (debt, payday) pairs, as the `${debtId}:${YYYY-MM-DD}`
  // keys projectCyclePlan's skippedExtraPairs opt expects — simulatePayoff
  // below needs this for the same reason: its own month-1 tick used to
  // always assume every paycheck this month lands in full, so a household-
  // skipped payday still counted toward the "Projected Payoff" chart even
  // though the Payoff Calendar (projectCyclePlan, further below) already
  // correctly excluded it (real report, 2026-09-14: Amazon Card's Sep 3
  // payday, skipped, was the actual reason its chart payoff month
  // disagreed with the calendar's).
  const skippedExtraPairs = useMemo(
    () => new Set(payoffExtraSkips.map((s) => `${s.debtId}:${s.paycheckDate}`)),
    [payoffExtraSkips],
  );
  // Frozen amount/isPayoff for a skipped line — see the schema comment on
  // PayoffExtraSkip.amountCents. Only entries that actually have one (a
  // pre-fix skip row has neither, and falls back to the live-simulated
  // amount below, same as before this existed).
  const skippedExtraAmountByKey = useMemo(
    () =>
      new Map(
        payoffExtraSkips
          .filter((s) => s.amountCents != null)
          .map((s) => [`${s.debtId}:${s.paycheckDate}`, { amountCents: s.amountCents!, isPayoff: s.isPayoff ?? false }]),
      ),
    [payoffExtraSkips],
  );


  // Each debt's own real due date + cadence, straight from the tracked
  // DebtPayment — without this, projectCyclePlan has no way to know a
  // debt's actual billing day and every predictive minimum line falls back
  // to the same generic "first paycheck of the month" date, making every
  // debt's future minimum land on the same day.
  //
  // Uses cycleMinimum.nextDueDate (the raw, always-future tracked date),
  // not cycleMinimum.dueDate, once this cycle is caught up — dueDate then
  // points at whichever occurrence landed in *this* calendar month for
  // debt-row.tsx's own slot-matching, which for a caught-up debt is a past,
  // already-settled date. Feeding that into projectCyclePlan re-simulates a
  // minimum deduction *and* an interest tick against an amount already
  // reflected in the real balanceCents it starts from — see CycleMinimum's
  // own comment on nextDueDate for the real household report this fixes.
  //
  // But nextDueDate itself only ever ADVANCES once its due date is already
  // behind today (matchDebtPayments' own rollover grace — see
  // debt-payments.ts) — it never jumps ahead early just because that
  // cycle's payment already posted, so the naive read above can feed
  // projectCyclePlan a "due" event days away for a minimum already paid
  // (real report, 2026-09-11: Amazon Card). correctedNextDueDate
  // (debt-payoff.ts) is the shared fix — also used by debt-payments.ts's
  // own correctedDueDateByDebtId, so the two can't drift the way they
  // already have once (2026-09-06, Quicksilver).
  const dueDateByDebtId = useMemo(() => {
    const map = new Map<string, { date: Date; cadence: BillCadence }>();
    for (const d of debts) {
      const cm = d.cycleMinimum;
      if (!cm) continue;
      const date = correctedNextDueDate(cm.paidThisCycle, cm.nextDueDate, cm.dueDate, cm.cadence);
      map.set(d.id, { date, cadence: cm.cadence });
    }
    return map;
  }, [debts]);
  // Real extra payments (beyond the minimum slot) already posted this cycle,
  // per debt — the same figure src/lib/debt-payments.ts's
  // correctedDueDateByDebtId.extraPaidCents computes server-side for the
  // dashboard/ICS. projectCyclePlan's past-payday branch nets this against
  // the current cycle's own display "pending" extra line, so a real synced
  // payment isn't double-counted alongside the to-do line it should instead
  // be covering/replacing.
  const extraPaidThisCycleByDebtId = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of debts) {
      const total = d.cycleMinimum?.extraPaymentsBeyondSlots.reduce((s, p) => s + Math.abs(p.amountCents), 0) ?? 0;
      map.set(d.id, total);
    }
    return map;
  }, [debts]);
  // debtId -> its isPayoff snapshot row, per month key (yyyy*12+m) — a debt
  // only ever pays off once, but keying by month keeps this month's/last
  // month's own calendar page from ever picking up the other's snapshot.
  const payoffSnapshotByDebtIdAndMonth = useMemo(() => {
    const map = new Map<string, { dueDate: Date; amountCents: number }>();
    for (const s of payoffSnapshots) {
      const dueDate = new Date(s.dueDate);
      const monthKey = dueDate.getUTCFullYear() * 12 + dueDate.getUTCMonth();
      map.set(`${s.debtId}:${monthKey}`, { dueDate, amountCents: s.amountCents });
    }
    return map;
  }, [payoffSnapshots]);
  // Full per-cycle breakdown (this cycle + the next 2, predictive) — the
  // data source for the "Payoff Calendar" section below: starting balance
  // and every minimum/extra line landing in each cycle, per debt. Runs
  // independent of minimumOnly since a minimum payment is owed every cycle
  // regardless of extra-payment strategy.
  // postedExtraNettedByDebtId: real extra the past-payday branch already
  // netted away — see confirmProjectedExtras' nettedByPlanCents.
  const result = useMemo(
    () =>
      projectionDebtInputs.length > 0
        ? simulatePayoff(projectionDebtInputs, {
            order: orderMode,
            rollFreedMinimums,
            extraPerPaycheckCents,
            income: income ?? undefined,
            alreadyFreedMinimums,
            extraEligibleIds: inPlanIds,
            minimumSatisfiedThisCycleIds,
            skippedExtraPairs,
            // Same inputs the Payment Calendar's projectCyclePlan gets, so
            // the chart's first months are that engine's own (see
            // simulatePayoff's seed months).
            dueDateByDebtId,
            extraPaidThisCycleByDebtId,
            rollFreedMinimumsSplit,
          })
        : null,
    [
      projectionDebtInputs,
      orderMode,
      rollFreedMinimums,
      rollFreedMinimumsSplit,
      extraPerPaycheckCents,
      income,
      alreadyFreedMinimums,
      inPlanIds,
      minimumSatisfiedThisCycleIds,
      skippedExtraPairs,
      dueDateByDebtId,
      extraPaidThisCycleByDebtId,
    ],
  );
  // The same plan with no extra payments at all — the baseline for "how much
  // interest is this plan actually saving you." Capped to the actual plan's
  // own payoff horizon so the comparison is apples-to-apples: interest paid
  // by each scenario over the same window. Without the cap, a debt whose
  // minimum doesn't cover its own interest would run this baseline out to
  // the full 50-year safety cap and rack up decades of runaway compounding
  // that was never a meaningful "savings" figure.
  const baseline = useMemo(
    () =>
      projectionDebtInputs.length > 0 && result
        ? simulatePayoff(projectionDebtInputs, {
            order: orderMode,
            rollFreedMinimums: false,
            extraPerPaycheckCents: 0,
            income: income ?? undefined,
            horizonMonths: result.months,
            extraEligibleIds: inPlanIds,
            minimumSatisfiedThisCycleIds,
            dueDateByDebtId,
          })
        : null,
    [projectionDebtInputs, orderMode, income, result, inPlanIds, minimumSatisfiedThisCycleIds, dueDateByDebtId],
  );
  // Every list on this page renders the same DebtRow; only a few props
  // differ per list (the live plan's own order/extras, the Last Month
  // look-back), passed as overrides.
  const debtRow = (debt: PlannerDebt, overrides: Partial<ComponentProps<typeof DebtRow>> = {}) => (
    <DebtRow
      key={debt.id}
      debt={debt}
      attackOrderIndex={null}
      payoffDate={null}
      suggestedAccount={debt.suggestedAccount}
      needsSetup={debt.needsSetup}
      patternCount={debt.patternCount}
      draggable={false}
      cycleMinimum={debt.cycleMinimum}
      expectedExtras={[]}
      readOnly={!isOwner}
      todayISO={todayISO}
      {...overrides}
    />
  );

  const interestSavedCents =
    result && baseline ? Math.max(0, baseline.totalInterestPaidCents - result.totalInterestPaidCents) : 0;

  const { cyclePlan, postedExtraNettedByDebtId } = useMemo(() => {
    const postedExtraNettedByDebtId = new Map<string, number>();
    const cyclePlan =
      projectionDebtInputs.length > 0 && income
        ? projectCyclePlan(projectionDebtInputs, {
            order: orderMode,
            rollFreedMinimums,
            rollFreedMinimumsSplit,
            extraPerPaycheckCents,
            income,
            monthsCount: 3,
            minimumSatisfiedThisCycleIds,
            dueDateByDebtId,
            alreadyFreedMinimums,
            extraEligibleIds: inPlanIds,
            extraPaidThisCycleByDebtId,
            skippedExtraPairs,
            postedExtraNettedOut: postedExtraNettedByDebtId,
          })
        : [];
    return { cyclePlan, postedExtraNettedByDebtId };
  }, [
    projectionDebtInputs,
    orderMode,
    rollFreedMinimums,
    rollFreedMinimumsSplit,
    extraPerPaycheckCents,
    income,
    minimumSatisfiedThisCycleIds,
    dueDateByDebtId,
    alreadyFreedMinimums,
    extraPaidThisCycleByDebtId,
    skippedExtraPairs,
    inPlanIds,
  ]);
  // This cycle's extra-payment lines, per debt, merged into DebtRow's own
  // real-payment ledger alongside cycleMinimum. Cycle 0 never carries a
  // simulated "minimum" line (see projectCyclePlan) — the real cycleMinimum
  // tracker already covers that for the live cycle.
  //
  // `confirmed` is derived from real money, not a manual click (household
  // feedback 2026-08-26: automate via SimpleFIN wherever possible) —
  // matchDebtPayments already links every synced payment to its debt
  // regardless of amount, so a real payment beyond this cycle's minimum
  // slot(s) already sits in cycleMinimum.extraPayments by the time this
  // runs. Each debt's real extra total gets consumed oldest-projected-line-
  // first, so "sent $150 in one lump" correctly checks off a $50 + $100
  // pair of projected lines instead of only ever matching an exact amount.
  // Money that already retired a payoff target the live plan has since
  // dropped is spent first and never confirms anything still on the board —
  // see supersededPayoffExtraByDebtId and confirmProjectedExtras.
  const thisCycleExtrasByDebtId = useMemo(() => {
    const map = new Map<string, CycleExtra[]>();
    for (const entry of cyclePlan[0]?.debts ?? []) {
      const debt = debts.find((d) => d.id === entry.debtId);
      map.set(
        entry.debtId,
        confirmProjectedExtras(
          entry.lines.filter((l) => l.kind === "extra"),
          debt?.cycleMinimum?.extraPaymentsBeyondSlots.reduce((s, p) => s + p.amountCents, 0) ?? 0,
          supersededPayoffExtraByDebtId[entry.debtId] ?? 0,
          postedExtraNettedByDebtId.get(entry.debtId) ?? 0,
        ).map((l) => {
          const frozen = l.skipped
            ? skippedExtraAmountByKey.get(`${entry.debtId}:${l.date.toISOString().slice(0, 10)}`)
            : undefined;
          return {
            paycheckDate: l.date,
            amountCents: frozen?.amountCents ?? l.amountCents,
            isPayoff: frozen?.isPayoff ?? l.isPayoff,
            poolBreakdown: l.poolBreakdown,
            confirmed: l.confirmed,
            pending: l.pending,
            skipped: l.skipped,
          };
        }),
      );
    }
    return map;
  }, [cyclePlan, postedExtraNettedByDebtId, debts, supersededPayoffExtraByDebtId, skippedExtraAmountByKey]);

  // "List" (the DebtRow/PayoffCycleCard cards) vs "Calendar" (a real
  // month-grid with paid/due/expected days highlighted) — two views over
  // the exact same underlying data, toggled per household preference, not
  // persisted (cheap to recompute, no strong reason to remember it across
  // visits the way strategyExpanded is).
  const [calendarView, setCalendarView] = useState(false);
  // Which cycle is currently paged into view — 0 = "This cycle" (live,
  // draggable in Custom order), 1/2 = the two predictive cycles ahead, all
  // three sharing one nav, one shown at a time. Clamped against however
  // many cycles are actually available (cyclePlan is empty without income,
  // since a predictive cycle needs real paycheck dates to project at all —
  // "This cycle" alone is still viewable then) rather than stored
  // pre-clamped, so a debt-list change that shrinks cyclePlan doesn't leave
  // this pointing past the end. Offset -1 is the one look-back page ("Last
  // Month"), only reachable when last month actually had payments or due
  // dates. It has a list view too (household request, 2026-10-02): a covered
  // minimum whose due date already slipped into last month is otherwise
  // unskippable, since the skip control only lives on a DebtRow ledger.
  const [cycleOffset, setCycleOffset] = useState(0);
  const maxCycleOffset = income ? Math.max(0, cyclePlan.length - 1) : 0;
  const hasLastMonthActivity = useMemo(
    () =>
      debts.some(
        (d) => (d.cycleMinimum?.lastMonthPayments.length ?? 0) > 0 || (d.lastMonthCycleMinimum?.slots.length ?? 0) > 0,
      ),
    [debts],
  );
  const minCycleOffset = hasLastMonthActivity ? -1 : 0;
  const clampedCycleOffset = Math.min(Math.max(cycleOffset, minCycleOffset), maxCycleOffset);
  const isLastMonth = clampedCycleOffset === -1;
  const isThisCycle = clampedCycleOffset === 0;
  const viewedMonth = clampedCycleOffset > 0 ? cyclePlan[clampedCycleOffset] : null;
  // First day of last month. Local getters pick the viewer's calendar month,
  // then Date.UTC re-anchors to UTC midnight so CycleCalendarView's UTC
  // getters read it back as that same month — a bare `new Date(y, m-1, 1)` is
  // local midnight, which for a viewer *east* of UTC is still the prior month
  // through a UTC getter.
  const lastMonthDate = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  }, []);
  // This calendar month, same UTC-midnight anchoring — fed to
  // CycleCalendarView for the live cycle and to the projection chart. A raw
  // `new Date()` read via getUTC* (which both consumers do) is next month for
  // any viewer west of UTC in their evening (2026-08-31 report: the whole
  // Payoff Calendar shifted a month and emptied out).
  const thisMonthDate = useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  }, []);
  const cycleLabel = isLastMonth
    ? "Last Month"
    : isThisCycle
      ? "This Month"
      : viewedMonth && formatDate(viewedMonth.monthDate, { month: "long", year: "numeric" });

  // Priority badges for a predictive cycle, renumbered relative to only the
  // debts still owed a balance *by that cycle* — not attackOrderIndexById's
  // fixed global numbering (computed once from today's balances). Without
  // this, a debt projected to pay off in an earlier cycle would leave a gap
  // (e.g. #1 vanishes) instead of everyone below it moving up, even though
  // the cards themselves already drop a paid-off debt from the list.
  // Filtering `attackOrder` (already in priority order) down to just this
  // cycle's still-active ids preserves relative order while renumbering
  // 0..N sequentially.
  const viewedMonthAttackOrderIndexById = useMemo(() => {
    if (!viewedMonth) return new Map<string, number>();
    const stillOwed = new Set(viewedMonth.debts.filter((d) => d.startBalanceCents > 0).map((d) => d.debtId));
    const relevant = attackOrder.filter((id) => stillOwed.has(id));
    return new Map(relevant.map((id, i) => [id, i]));
  }, [viewedMonth, attackOrder]);

  // Real-ledger day events for "This cycle" — every already-made payment
  // (paid), the still-open minimum if not yet satisfied (due), and every
  // projected extra allocation landing this cycle (expected). Unlike
  // cyclePlan[0] (which deliberately omits a simulated minimum line, see
  // projectCyclePlan), this pulls the minimum straight from the real
  // cycleMinimum tracker so the calendar view matches the card-list ledger
  // exactly. Grouped by getUTCDate(), not getDate() — every date feeding
  // this (occurredOn, dueDate, paycheck dates) is a `@db.Date` value, UTC
  // midnight for a specific calendar day (src/lib/date.ts); a local getter
  // here silently rewinds a day for any viewer west of UTC (this app has
  // hit that exact bug more than once — see WORKING_ON.md).
  const thisCycleDayEvents = useMemo(() => {
    const map = new Map<number, CalendarDayEvent[]>();
    const now = new Date();
    const add = (
      date: Date,
      debtName: string,
      amountCents: number | undefined,
      status: CalendarDayEvent["status"],
      inPlan: boolean,
      isPayoff?: boolean,
      poolBreakdown?: CalendarDayEvent["poolBreakdown"],
      pendingConfirmation?: boolean,
      isExtraPayment?: boolean,
    ) => {
      // The grid only ever shows one real calendar month (see monthDate=
      // {new Date()} below) and buckets purely by day-of-month — a monthly
      // cadence's cycleMinimum window is [dueDate - 1 month, dueDate), which
      // routinely includes the *previous* cycle's already-made payment
      // (real report, 2026-08-21: PayPal Credit's last payment on Jul 27
      // landed in the Aug 27 cell too, since both are day-of-month 27, and
      // rendered as a second, misleadingly duplicate-looking "PayPal Credit
      // $65" next to that same day's real due line). Dropping anything
      // outside the displayed month keeps the grid to only what's actually
      // on it.
      // `date` is a `@db.Date` (UTC midnight) — compare its UTC month against
      // the viewer's *local* current month (now.getMonth()), not now's UTC
      // month. After ~6pm west of UTC the two disagree, and reading `now` in
      // UTC dropped every one of this month's real payments off the grid
      // (2026-08-31).
      if (date.getUTCFullYear() !== now.getFullYear() || date.getUTCMonth() !== now.getMonth()) return;
      const day = date.getUTCDate();
      const list = map.get(day) ?? [];
      list.push({ debtName, amountCents, status, inPlan, isPayoff, poolBreakdown, pendingConfirmation, isExtraPayment });
      map.set(day, list);
    };
    for (const debt of debts) {
      const cm = debt.cycleMinimum;
      let payoffShown = false;
      const planExtraPaymentIds = new Set(cm?.planExtraPaymentIds ?? []);
      if (cm) {
        // The payment that actually zeroed the balance gets the same star an
        // "expected" projected payoff line gets — see pickPayoffPaymentTime
        // (debt-payoff.ts) for why this can't just be "the latest real
        // payment this cycle."
        const payoffPaymentTime = pickPayoffPaymentTime(cm.payments, debt.balanceCents, debt.paidOffDate);
        for (const p of cm.payments) {
          const isPayoff = p.occurredOn.getTime() === payoffPaymentTime;
          if (isPayoff) payoffShown = true;
          add(p.occurredOn, debt.name, p.amountCents, "paid", debt.includeInPayoffPlan, isPayoff, undefined, undefined, planExtraPaymentIds.has(p.id));
        }
        // A debt already at $0 balance is done — its real ledger this cycle
        // may still carry the payment that actually cleared it (handled
        // above, "paid"/star), but shouldn't keep showing a recurring "due"
        // line after that (real household request, 2026-08-21: "ones paid
        // off are just dropped from calendar view" — a REVOLVING debt at $0
        // can still carry an active tracker "watching for new charges,"
        // whose due date otherwise keeps generating a stray due line here
        // indefinitely).
        // amountCents > 0: a $0-minimum debt (paid in full each cycle, or
        // ignoreMinimumPayment) has a due date but nothing owed on it — no
        // "$0.00 (Due)" row (household report, 2026-08-31).
        // One line per unpaid slot, not one line at cm.dueDate — a cadence
        // shorter than a month (e.g. BIWEEKLY) can land more than one
        // occurrence inside this same calendar month, and cm.dueDate only
        // ever points at the *last* of them (see its own comment above), so
        // an earlier occurrence in the same month silently had no marker at
        // all (real report, 2026-09-06: Nike - Klarna's Sep 7 installment
        // showed on the dashboard's Payment Calendar and the /debts list
        // view — both of which walk every slot — but not here).
        if (debt.balanceCents > 0 && cm.amountCents > 0) {
          // Capped at the payoff amount, same as every other due line (minimumOwedCents).
          const dueCents = minimumOwedCents({ amountDueCents: 0, amountCents: cm.amountCents }, debt);
          for (const slot of cm.slots) {
            if (!slot.payment) add(slot.date, debt.name, dueCents, "due", debt.includeInPayoffPlan);
          }
          // A minimum an earlier, bigger payment already covered stays on the
          // calendar as a "due" cell unless the household skipped it — same
          // rule as the debt row's ledger (2026-09-20).
          for (const date of coveredMinimumDates({
            slots: cm.slots,
            extraPayments: cm.extraPayments,
            minimumCents: ledgerMinimumCents({
              paidOff: false,
              nextDueThisMonth: cm.nextDueThisMonth,
              amountDueCents: cm.amountDueCents,
              minimumCents: cm.amountCents,
            }),
            skippedDates: new Set(cm.skippedSlotDates ?? []),
          })) {
            add(date, debt.name, dueCents, "due", debt.includeInPayoffPlan);
          }
        }
      }
      // Fallback for a debt paid off with no matched payment transaction to
      // hang the star on (e.g. a synced balance dropping straight to $0) —
      // dated off the plan's own PayoffExtraSnapshot when one exists for
      // this month (the date the household actually expected, not whenever
      // the balance sync happened to notice), falling back to
      // Debt.paidOffDate only when there's no such snapshot.
      if (!payoffShown && debt.balanceCents === 0) {
        const snapshot = payoffSnapshotByDebtIdAndMonth.get(`${debt.id}:${now.getFullYear() * 12 + now.getMonth()}`);
        if (snapshot) {
          // pendingConfirmation: true — neither branch here has an actual
          // transaction behind it, only the plan's own projection or the
          // raw balance-crossing date (see CalendarDayEvent's own comment).
          add(snapshot.dueDate, debt.name, snapshot.amountCents, "paid", debt.includeInPayoffPlan, true, undefined, true);
        } else if (
          debt.paidOffDate &&
          debt.paidOffDate.getUTCFullYear() === now.getFullYear() &&
          debt.paidOffDate.getUTCMonth() === now.getMonth()
        ) {
          add(
            debt.paidOffDate,
            debt.name,
            debt.paidOffAmountCents ?? undefined,
            "paid",
            debt.includeInPayoffPlan,
            true,
            undefined,
            true,
          );
        }
      }
      // A skipped line is a household "not doing this one" decision — the
      // calendar grid is read-only (the skip/undo control lives on the list
      // view below instead), so it just omits the line entirely.
      for (const extra of minimumOnly ? [] : (thisCycleExtrasByDebtId.get(debt.id) ?? [])) {
        if (extra.skipped) continue;
        add(extra.paycheckDate, debt.name, extra.amountCents, "expected", debt.includeInPayoffPlan, extra.isPayoff, extra.poolBreakdown);
      }
    }
    return map;
  }, [debts, thisCycleExtrasByDebtId, minimumOnly, payoffSnapshotByDebtIdAndMonth]);

  // Same shape for whichever predictive cycle is currently paged into
  // view — every minimum/extra line projectCyclePlan produced for that
  // month, grouped by (UTC) day-of-month.
  const viewedMonthDayEvents = useMemo(() => {
    const map = new Map<number, CalendarDayEvent[]>();
    if (!viewedMonth) return map;
    const add = (
      date: Date,
      debtName: string,
      amountCents: number,
      status: CalendarDayEvent["status"],
      inPlan: boolean,
      isPayoff: boolean,
      poolBreakdown?: CalendarDayEvent["poolBreakdown"],
    ) => {
      const day = date.getUTCDate();
      const list = map.get(day) ?? [];
      list.push({ debtName, amountCents, status, inPlan, isPayoff, poolBreakdown });
      map.set(day, list);
    };
    for (const entry of viewedMonth.debts) {
      // Full `debts` (not just activeDebts) — cyclePlan now also carries
      // household-excluded debts (Debt.includeInPayoffPlan false) so their
      // own normal payment schedule still shows on the calendar (real
      // household request, 2026-08-21: "debts that aren't included in the
      // payoff plan should still show on the calendar view like the
      // others" — only the card-list view stays attack-order-only, see
      // inPlanIds filtering the withBalance list below).
      const debt = debts.find((d) => d.id === entry.debtId);
      for (const line of entry.lines) {
        // A projected month's minimum lines are "due", not "expected" — only
        // a real extra allocation gets the extra-payment icon / day-cell
        // badge (household report, 2026-09-01: every payday-and-due-date cell
        // in a future month was showing the extra marker).
        add(
          line.date,
          debt?.name ?? "",
          line.amountCents,
          line.kind === "extra" ? "expected" : "due",
          inPlanIds.has(entry.debtId),
          line.isPayoff,
          line.poolBreakdown,
        );
      }
    }
    return map;
  }, [viewedMonth, debts, inPlanIds]);

  // The "Last Month" look-back page — every real payment that landed in the
  // previous calendar month, grouped by (UTC) day-of-month. Only "paid"
  // events: last month is settled, so there's no live "due" line to chase
  // and no forward projection to overlay. A debt whose Debt.paidOffDate
  // falls in that month gets its last payment starred, same as
  // thisCycleDayEvents does for the current month.
  const lastMonthDayEvents = useMemo(() => {
    const map = new Map<number, CalendarDayEvent[]>();
    // lastMonthDate is UTC-midnight-anchored (see its memo) — read it back
    // with UTC getters, matching the `@db.Date` values compared against below.
    const lmYear = lastMonthDate.getUTCFullYear();
    const lmMonth = lastMonthDate.getUTCMonth();
    const add = (
      date: Date,
      debtName: string,
      amountCents: number | undefined,
      inPlan: boolean,
      isPayoff: boolean,
      pendingConfirmation?: boolean,
    ) => {
      const day = date.getUTCDate();
      const list = map.get(day) ?? [];
      list.push({ debtName, amountCents, status: "paid", inPlan, isPayoff, pendingConfirmation });
      map.set(day, list);
    };
    for (const debt of debts) {
      const payments = debt.cycleMinimum?.lastMonthPayments ?? [];
      const paidOffLastMonth =
        debt.paidOffDate != null &&
        debt.paidOffDate.getUTCFullYear() === lmYear &&
        debt.paidOffDate.getUTCMonth() === lmMonth;
      // See pickPayoffPaymentTime (debt-payoff.ts) — paidOffLastMonth alone
      // used to be enough, crediting whichever payment happened to be
      // latest even when it wasn't the one that actually closed the debt.
      const payoffPaymentTime = paidOffLastMonth ? pickPayoffPaymentTime(payments, debt.balanceCents, debt.paidOffDate) : null;
      let payoffShown = false;
      for (const p of payments) {
        const isPayoff = p.occurredOn.getTime() === payoffPaymentTime;
        if (isPayoff) payoffShown = true;
        add(p.occurredOn, debt.name, p.amountCents, debt.includeInPayoffPlan, isPayoff);
      }
      // Paid off via a synced balance drop with no matching payment row —
      // same PayoffExtraSnapshot preference as thisCycleDayEvents above
      // (the plan's own expected date, not whenever the balance sync
      // happened to notice), falling back to Debt.paidOffDate.
      if (!payoffShown && debt.balanceCents === 0) {
        const snapshot = payoffSnapshotByDebtIdAndMonth.get(`${debt.id}:${lmYear * 12 + lmMonth}`);
        if (snapshot) {
          add(snapshot.dueDate, debt.name, snapshot.amountCents, debt.includeInPayoffPlan, true, true);
        } else if (paidOffLastMonth && debt.paidOffDate) {
          add(debt.paidOffDate, debt.name, debt.paidOffAmountCents ?? undefined, debt.includeInPayoffPlan, true, true);
        }
      }
    }
    return map;
  }, [debts, lastMonthDate, payoffSnapshotByDebtIdAndMonth]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const baseIds = orderMode === "CUSTOM" ? customOrderIds : orderedActiveDebtIds;
    const oldIndex = baseIds.indexOf(String(active.id));
    const newIndex = baseIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = arrayMove(baseIds, oldIndex, newIndex);
    setCustomOrderIds(next);
    setOrderMode("CUSTOM");
    // Reordering auto-saves on drop (same eager-persist behavior as the old
    // up/down arrows) — unlike the strategy fields below, which wait for an
    // explicit Save.
    startOrderSaveTransition(async () => {
      try {
        await setDebtPayoffOrder(next);
        showToast("Order Saved");
      } catch {
        showToast("Couldn’t Save Order", "error");
      }
    });
  }

  const allDebtsPaidOff = debts.length > 0 && activeDebts.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* TotalDebtCard (passed down from page.tsx) and Payoff Strategy are
          both compact, non-inline-expanding cards — paired side by side at
          `lg:` (the "Stack→N-col card grid" idiom, WORKING_ON.md) instead of
          each stacked in its own capped-and-centered column, which on a wide
          desktop left both looking like orphaned mobile cards adrift in
          blank space (household report, 2026-09-23) — the donut/bar chart
          inside TotalDebtCard is already `w-full` and just needed the wider
          box to actually fill. */}
      {!allDebtsPaidOff && (
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:gap-6 lg:items-start">
          {totalDebtCard}

          {!isOwner ? (
            // Non-owner: always the static summary, never the editable form —
            // no toggle button either, since there's nothing behind it for them
            // to expand into (updateHouseholdPayoffPlan is owner-only, ./actions).
            <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Payoff Strategy</h2>
                <PlanBudgetBadge enabled={enabled} />
              </div>
              <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{strategySummary}</p>
            </div>
          ) : (
            <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
              <button
                type="button"
                onClick={toggleStrategy}
                aria-expanded={strategyExpanded}
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Payoff Strategy</h2>
                <div className="flex shrink-0 items-center gap-2">
                  <PlanBudgetBadge enabled={enabled} />
                  <ChevronDown
                    size={18}
                    className={`text-neutral-400 dark:text-neutral-500 transition-transform ${strategyExpanded ? "rotate-180" : ""}`}
                  />
                </div>
              </button>

              {!strategyExpanded && (
                <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">{strategySummary}</p>
              )}

              {strategyExpanded && (
                <form action={saveAction} className="mt-3 flex flex-col gap-3">
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Attack Order
                    <SelectField
                      name="order"
                      value={orderMode}
                      onChange={(v) => setOrderMode(v as PayoffOrder)}
                      options={[
                        { value: "AVALANCHE", label: "Avalanche" },
                        { value: "SNOWBALL", label: "Snowball" },
                        { value: "CUSTOM", label: "Custom" },
                      ]}
                      searchable={false}
                      large
                    />
                    <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
                      {orderMode === "AVALANCHE" &&
                        "Pays minimums on everything, puts every extra dollar toward the highest-interest debt first. Mathematically the cheapest path out of debt — usually your credit cards."}
                      {orderMode === "SNOWBALL" &&
                        "Pays minimums on everything, puts every extra dollar toward the smallest balance first. Costs a bit more in total interest, but clears individual debts faster — useful if you want momentum/quick wins."}
                      {orderMode === "CUSTOM" &&
                        "Uses the order you've dragged the debts into below, instead of sorting by APR or balance."}
                    </span>
                  </label>

                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Extra $ Per Paycheck
                    <MoneyInput
                      name="extra"
                      defaultCents={Math.round((parseFloat(extraDollars) || 0) * 100)}
                      onValueChange={setExtraDollars}
                      className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base font-normal tabular-nums focus:border-blue-900 focus:outline-none"
                    />
                    <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
                      How much extra — beyond every debt&apos;s minimum — you want to put toward debt each paycheck. Set
                      to $0 to simulate paying minimums only.
                    </span>
                  </label>

                  <label className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">Roll freed-up minimums into the next debt</span>
                    <Switch
                      checked={rollFreedMinimums}
                      onChange={() => setRollFreedMinimums((v) => !v)}
                      ariaLabel="Roll freed-up minimums into the next debt"
                    />
                  </label>
                  <input type="hidden" name="rollFreedMinimums" value={String(rollFreedMinimums)} />
                  <p className="-mt-2 text-xs text-gray-500 dark:text-neutral-400">
                    When a debt in your attack order is paid off, its old minimum payment isn&apos;t owed anywhere
                    anymore — this controls where that money goes. <strong>On</strong>: it&apos;s automatically added to
                    your extra-payment pool and attacks the next debt in line, so payments accelerate as each debt
                    clears (the classic &quot;debt snowball&quot; effect — on by default). <strong>Off</strong>: that
                    freed-up amount is left for you to spend or save elsewhere; only your fixed extra-per-paycheck amount
                    keeps attacking the next debt.
                  </p>

                  <input type="hidden" name="rollFreedMinimumsSplit" value={String(rollFreedMinimumsSplit)} />
                  {rollFreedMinimums && (
                    <>
                      <label className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">Split rolled minimums across paychecks</span>
                        <Switch
                          checked={rollFreedMinimumsSplit}
                          onChange={() => setRollFreedMinimumsSplit((v) => !v)}
                          ariaLabel="Split rolled minimums across paychecks"
                        />
                      </label>
                      <p className="-mt-2 text-xs text-gray-500 dark:text-neutral-400">
                        How the freed-up minimum above actually moves each month. <strong>On</strong>: spread evenly
                        across that month&apos;s paychecks, alongside your regular extra-per-paycheck amount (the
                        default). <strong>Off</strong>: the whole month&apos;s freed amount moves in one lump, timed to
                        the priority debt&apos;s own minimum due date instead — same total money, just one payment
                        instead of several smaller ones.
                      </p>
                    </>
                  )}

                  <label className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">Feed this plan into budgeting</span>
                    <Switch
                      checked={enabled}
                      onChange={() => setEnabled((v) => !v)}
                      ariaLabel="Feed this plan into budgeting"
                    />
                  </label>
                  <input type="hidden" name="enabled" value={String(enabled)} />
                  <p className="-mt-2 text-xs text-gray-500 dark:text-neutral-400">
                    When on, this plan&apos;s extra payments count as real upcoming spending: they show up in
                    &quot;upcoming this week&quot; on the dashboard, and in next month&apos;s budget projection for
                    whichever bucket each debt&apos;s payments are assigned to. When off, this page is projection-only
                    and nothing here affects your budget elsewhere.
                  </p>
                  {!income && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      No income with a pay schedule set up yet — extra payments are being smoothed evenly across each
                      month instead of landing on real paydays. Add one on the Income page for the Payoff Calendar below
                      to anchor to real paydays.
                    </p>
                  )}

                  {saveState.error && <p className="text-sm text-red-600 dark:text-red-400">{saveState.error}</p>}

                  <div className="flex items-center justify-end gap-3">
                    {isDirty ? (
                      <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Unsaved Changes</span>
                    ) : (
                      justSaved && (
                        <span className="flex items-center gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                          <Check size={16} /> Saved
                        </span>
                      )
                    )}
                    <button
                      type="submit"
                      disabled={savePending || !isDirty}
                      className="rounded-lg bg-blue-900 dark:bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {savePending ? "Saving…" : "Save Plan"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}

      {/* Once every debt hits $0 the Payoff Strategy card above disappears
          entirely — TotalDebtCard no longer has a grid partner, so it just
          renders alone in the same capped-and-centered column the paid-off
          list below uses. */}
      {allDebtsPaidOff && totalDebtCard && <div className="lg:mx-auto lg:max-w-3xl">{totalDebtCard}</div>}

      {/* The paid-off cards themselves (now the whole of `debts`, since
          activeDebts is empty) still deserve a home, so they render
          standalone here instead of vanishing along with the collapsible
          region they'd otherwise live in. */}
      {allDebtsPaidOff && trailingDebts.length > 0 && (
        <ul className="flex flex-col gap-3 lg:mx-auto lg:max-w-3xl">
          {trailingDebts.map((debt) => debtRow(debt))}
        </ul>
      )}

      {!allDebtsPaidOff && activeDebts.length > 0 && (
        <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Payoff Calendar</h2>
            {/* At lg+ the list and calendar render side by side (see the grid
                below), so this List/Calendar toggle is mobile-only. The
                Google/Apple subscribe buttons moved to the dashboard's
                Payment Calendar card (2026-09-03) — same ICS feed. */}
            <div className="flex rounded-lg border border-blue-100 dark:border-neutral-800 p-0.5 lg:hidden">
              <button
                type="button"
                onClick={() => setCalendarView(false)}
                aria-pressed={!calendarView}
                aria-label="List View"
                title="List View"
                className={`flex items-center justify-center rounded-md px-4 py-1.5 ${
                  !calendarView
                    ? "bg-blue-900 dark:bg-blue-700 text-white"
                    : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                <List size={15} />
              </button>
              <button
                type="button"
                onClick={() => setCalendarView(true)}
                aria-pressed={calendarView}
                aria-label="Calendar View"
                title="Calendar View"
                className={`flex items-center justify-center rounded-md px-4 py-1.5 ${
                  calendarView
                    ? "bg-blue-900 dark:bg-blue-700 text-white"
                    : "text-neutral-500 dark:text-neutral-400"
                }`}
              >
                <CalendarDays size={15} />
              </button>
            </div>
          </div>

          {/* Whether the extra-payment lines below are actually wired into the
              rest of the app or just a sandbox projection — same
              Household.payoffPlanEnabled the Payoff Strategy badge reads.
              Skipped on a minimums-only plan: there are no extra payments for
              the toggle to feed anywhere, so the distinction is moot. */}
          {!minimumOnly && (
            <div
              className={`mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                enabled
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
              }`}
            >
              {enabled ? (
                <Zap size={14} className="mt-0.5 shrink-0 fill-current" />
              ) : (
                <FlaskConical size={14} className="mt-0.5 shrink-0" />
              )}
              <p>
                <span className="font-semibold">{enabled ? "Feeding Into Budget" : "Projection Only"}</span>
                {" — "}
                {enabled
                  ? "the projected extra payments below count as real upcoming spending in “This Week's Bills” and next month's budget projection."
                  : "nothing below affects your budget. Turn on “Feed This Plan Into Budgeting” in Payoff Strategy to apply it."}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setCycleOffset(Math.max(minCycleOffset, clampedCycleOffset - 1))}
                disabled={clampedCycleOffset <= minCycleOffset}
                aria-label="Previous Month"
                className="rounded-lg p-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30"
              >
                <ChevronLeft size={18} />
              </button>
              <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{cycleLabel}</p>
              <button
                type="button"
                onClick={() => setCycleOffset((o) => Math.min(maxCycleOffset, o + 1))}
                disabled={clampedCycleOffset >= maxCycleOffset}
                aria-label="Next Month"
                className="rounded-lg p-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-30"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            {/* Desktop: the list (left) and the calendar (right) render side
                by side, so the calendar re-projects live as debts are dragged
                into a new attack order. Mobile: the List/Calendar toggle above
                picks one. A slot is `hidden lg:*` when the toggle has it
                hidden but the desktop grid still wants it.
                The calendar column is a fixed rail, not an equal 1fr split —
                a household with a long debt list (attack order + not-in-plan
                + paid-off cards) made the list column tower over the
                calendar's fixed ~6-row grid, leaving the calendar looking
                stranded in a sea of blank space beside/below it (desktop
                layout review, 2026-09-23). The list gets the remaining
                flexible width instead, and the calendar sticks in view while
                the list scrolls past it rather than sitting inert once
                scrolled by. */}
            <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-4 lg:items-start">
              {isLastMonth ? (
                <div className={`flex-col gap-3 ${calendarView ? "hidden lg:flex" : "flex"}`}>
                  {lastMonthListDebts.length > 0 ? (
                    <ul className="flex flex-col gap-3">
                      {lastMonthListDebts.map((debt) => (
                        debtRow(debt, {
                          suggestedAccount: undefined,
                          needsSetup: false,
                          patternCount: 0,
                          cycleMinimum: debt.lastMonthCycleMinimum ?? null,
                          lookBack: true,
                        })
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-neutral-400">No payments or due dates last month.</p>
                  )}
                </div>
              ) : (
                <div className={`flex-col gap-3 ${calendarView ? "hidden lg:flex" : "flex"}`}>
                  {isThisCycle ? (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                      <SortableContext items={orderedActiveDebtIds} strategy={verticalListSortingStrategy}>
                        <ul className="flex flex-col gap-3">
                          {orderedActiveDebtIds.map((id) => {
                            const debt = activeDebts.find((d) => d.id === id)!;
                            // Shown regardless of `enabled` ("Feed this plan
                            // into budgeting") — this page is the plan itself,
                            // so its own projection stays visible either way.
                            const extras = minimumOnly ? [] : thisCycleExtrasByDebtId.get(id) ?? [];
                            return (
                              debtRow(debt, {
                                attackOrderIndex: minimumOnly ? null : attackOrderIndexById.get(id) ?? null,
                                payoffDate: result?.perDebt.find((p) => p.id === id)?.payoffDate ?? null,
                                draggable: isOwner && orderMode === "CUSTOM",
                                expectedExtras: extras,
                              })
                            );
                          })}
                        </ul>
                      </SortableContext>
                    </DndContext>
                  ) : (
                    (() => {
                      // Predictive cycle: every debt still owed a balance by
                      // this month renders as a projected PayoffCycleCard,
                      // in-plan ones first (attack-order badge) then
                      // household-excluded ones (BNPL etc., no badge) —
                      // projectCyclePlan walks each debt's real cadence
                      // forward, so a biweekly BNPL plan shows its two
                      // September installments here, not this month's ledger.
                      // Paid-off debts never appear in a future cycle at all.
                      const inPlanEntries =
                        viewedMonth?.debts.filter((d) => d.startBalanceCents > 0 && inPlanIds.has(d.debtId)) ?? [];
                      const otherEntries =
                        viewedMonth?.debts.filter((d) => d.startBalanceCents > 0 && !inPlanIds.has(d.debtId)) ?? [];
                      const entries = [...inPlanEntries, ...otherEntries];
                      return entries.length > 0 ? (
                        <ul className="flex flex-col gap-3">
                          {entries.map((entry) => (
                            <PayoffCycleCard
                              key={entry.debtId}
                              // Full `debts`, not `activeDebts` — an excluded
                              // debt (BNPL, includeInPayoffPlan false) still
                              // projects a card here and needs its name resolved.
                              name={debts.find((d) => d.id === entry.debtId)?.name ?? ""}
                              attackOrderIndex={minimumOnly ? null : viewedMonthAttackOrderIndexById.get(entry.debtId) ?? null}
                              startBalanceCents={entry.startBalanceCents}
                              endBalanceCents={entry.endBalanceCents}
                              lines={entry.lines}
                            />
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-500 dark:text-neutral-400">
                          Every debt is projected to be paid off by this month.
                        </p>
                      );
                    })()
                  )}

                  {/* The full-ledger DebtRow view (this cycle's real payments)
                      is a "This Month" thing — a future cycle shows these
                      debts as projected PayoffCycleCards above instead. */}
                  {isThisCycle && notInPlanDebts.length > 0 && (
                    <ul className="flex flex-col gap-3">
                      {notInPlanDebts.map((debt) => debtRow(debt, { payoffDate: result?.perDebt.find((p) => p.id === debt.id)?.payoffDate ?? null }))}
                    </ul>
                  )}

                  {/* Paid-off debts only ever show under "This Month" (and only
                      when not hidden — paidOffDebts already excludes
                      d.hiddenAt). A future cycle projects forward from live
                      balances, where a $0 debt simply isn't part of the picture. */}
                  {isThisCycle && paidOffDebts.length > 0 && (
                    <ul className="flex flex-col gap-3">
                      {paidOffDebts.map((debt) => debtRow(debt))}
                    </ul>
                  )}
                </div>
              )}

              <div className={`${calendarView ? "" : "hidden lg:block"} lg:sticky lg:top-4`}>
                {isLastMonth ? (
                  <CycleCalendarView monthDate={lastMonthDate} eventsByDay={lastMonthDayEvents} />
                ) : isThisCycle ? (
                  <CycleCalendarView monthDate={thisMonthDate} eventsByDay={thisCycleDayEvents} />
                ) : (
                  viewedMonth && (
                    <CycleCalendarView monthDate={viewedMonth.monthDate} eventsByDay={viewedMonthDayEvents} />
                  )
                )}
              </div>
            </div>

            {!income && (
              <p className="text-xs text-gray-500 dark:text-neutral-400">
                Add income with a pay schedule on the Income page to project the next 2 cycles.
              </p>
            )}
          </div>
        </div>
      )}

      {!allDebtsPaidOff && result && result.timeline.length > 1 && projectionDebtInputs.length > 0 && (
        // Full main width on desktop, not capped like the alerts: its
        // projection chart scales with the card (same reasoning as
        // /networth's headline card), and a 768px strip under the
        // full-width calendar card looked orphaned (2026-10-08).
        <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
          <button
            type="button"
            onClick={() => setProjectedPayoffCollapsed(!projectedPayoffCollapsed)}
            aria-expanded={!projectedPayoffCollapsed}
            className="mb-2 flex w-full items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400"
          >
            <span className="flex-1 text-left">Projected Payoff</span>
            {projectedPayoffCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>

          {/* Collapsed on desktop: stats stack in one column on the left and
              a Total-only sparkline fills the rest of the full-width card
              (clicking it expands the card). The sparkline stays mounted
              while expanded (just `hidden`) so its rise animation plays once
              per page load, not on every collapse. Mobile is unchanged. */}
          <div className={projectedPayoffCollapsed ? "lg:flex lg:items-center lg:gap-8" : undefined}>
          <div className={projectedPayoffCollapsed ? "lg:w-64 lg:shrink-0" : undefined}>
          {result.debtFreeDate ? (
            <div className={`grid grid-cols-2 gap-3 text-sm ${projectedPayoffCollapsed ? "lg:grid-cols-1" : "lg:grid-cols-3"}`}>
              <div>
                <p className="text-gray-500 dark:text-neutral-400">Debt-Free</p>
                <p className="font-medium">
                  {formatDate(result.debtFreeDate, { month: "long", year: "numeric" })}{" "}
                  <span className="text-gray-500 dark:text-neutral-400">({result.months} mo)</span>
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-neutral-400">Total Interest</p>
                <p className="font-medium">{formatCents(result.totalInterestPaidCents)}</p>
              </div>
              {interestSavedCents > 0 && (
                <div className="col-span-2 lg:col-span-1">
                  <p className="text-gray-500 dark:text-neutral-400">Interest Saved vs. Minimums Only</p>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">{formatCents(interestSavedCents)}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-red-600 dark:text-red-400">Not projected to pay off within 50 years at this rate.</p>
          )}
          </div>
          <button
            type="button"
            onClick={() => setProjectedPayoffCollapsed(false)}
            aria-label="Show Projected Payoff Chart"
            title="Show Projected Payoff Chart"
            className={projectedPayoffCollapsed ? "hidden lg:block lg:min-w-0 lg:flex-1" : "hidden"}
          >
            <PayoffProjectionSparkline timeline={result.timeline} startDate={thisMonthDate} />
          </button>
          </div>

          {!projectedPayoffCollapsed && (
            <>
              {result.neverPaysOff.length > 0 && (
                <p className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {result.neverPaysOff.join(", ")}{" "}
                  {result.neverPaysOff.length === 1 ? "doesn't" : "don't"} generate enough minimum payment to cover its
                  own interest — it {result.neverPaysOff.length === 1 ? "needs" : "need"} extra payments to ever clear.
                </p>
              )}

              <div className="mt-4">
                <PayoffProjectionChart
                  debts={projectionDebtInputs.map((d) => ({ id: d.id, name: d.name }))}
                  timeline={result.timeline}
                  startDate={thisMonthDate}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
