import Link from "next/link";
import { Settings } from "lucide-react";
import { db } from "@/lib/db";
import { requireFullAccess } from "@/lib/access";
import type { PayoffOrder } from "@/lib/debt-payoff";
import { AppShell } from "@/components/app-shell";
import { nameSimilarity } from "@/lib/fuzzy-match";
import {
  detectDebtPaymentSuggestions,
  debtNeedsSetup,
  getActiveInsufficientMinimumDebts,
  getActiveDebtsNeedingSetup,
  getPendingDebtAmountReviews,
  getPendingDebtBalanceReviews,
  getPayoffExtraSkipRows,
  supersededPayoffExtraByDebtInPeriod,
  planExtraTargetsByDebt,
} from "@/lib/debt-payments";
import { tracksMinimum } from "@/lib/minimum-ledger";
import { buildCycleSlots, cycleDueDate, recentPaymentsWhere, slotBounds, splitPlanExtraPayments, extraPaymentsBeyondSlots as resolveExtraPaymentsBeyondSlots } from "@/lib/cycle-slots";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { todayAsUTCDate } from "@/lib/date";
import { recordDebtSnapshot, getDebtTrend } from "@/lib/debt-history";
import { getPrimaryIncomeSchedule } from "@/lib/income";
import { BillSuggestions } from "@/app/bills/bill-suggestions";
import { DebtAmountReviewCard } from "@/components/debt-amount-review-card";
import { DebtBalanceReviewCard } from "@/components/debt-balance-review-card";
import { PayoffPlanner, type PlannerDebt } from "./payoff-planner";
import { TotalDebtCard } from "./total-debt-card";
import { MinPaymentWarning } from "./min-payment-warning";
import { NeedsSetupWarning } from "./needs-setup-warning";
import type { CycleMinimum } from "./debt-row";

export default async function DebtsPage() {
  const session = await requireFullAccess();
  // /debts itself stays readable (view-only) for a full-access non-owner —
  // 2026-08-21 household decision — but every one of these three "go fix a
  // debt" nudges resolves through a debt-editing action that's now
  // owner-only (see requireOwner in debts/actions.ts), so they'd otherwise
  // be dead-end buttons for anyone else. Skipped at the fetch, not just the
  // render, same as the dashboard's copies of these signals (src/app/page.tsx).
  const isOwner = session.user.role === "OWNER";

  const [
    household,
    rawDebts,
    income,
    accounts,
    categories,
    debtSuggestions,
    insufficientMinimumDebts,
    pendingDebtAmountReviews,
    pendingDebtBalanceReviews,
    payoffExtraSkips,
  ] =
    await Promise.all([
      db.household.findUniqueOrThrow({
        where: { id: session.user.householdId },
        select: {
          payoffOrder: true,
          payoffExtraCents: true,
          payoffRollFreedMinimums: true,
          payoffRollFreedMinimumsSplit: true,
          payoffPlanEnabled: true,
        },
      }),
      db.debt.findMany({
        where: { householdId: session.user.householdId },
        orderBy: { sortOrder: "asc" },
        include: { account: { select: { name: true, orgName: true, displayName: true } } },
      }),
      getPrimaryIncomeSchedule(session.user.householdId),
      db.account.findMany({
        where: { householdId: session.user.householdId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, displayName: true, orgName: true, accountType: true },
      }),
      db.billCategory.findMany({
        where: { householdId: session.user.householdId },
        select: { id: true, name: true, bucketId: true },
        orderBy: { name: "asc" },
      }),
      isOwner ? detectDebtPaymentSuggestions(session.user.householdId) : Promise.resolve([]),
      isOwner ? getActiveInsufficientMinimumDebts(session.user.householdId) : Promise.resolve([]),
      isOwner ? getPendingDebtAmountReviews(session.user.householdId) : Promise.resolve([]),
      isOwner ? getPendingDebtBalanceReviews(session.user.householdId) : Promise.resolve([]),
      getPayoffExtraSkipRows(session.user.householdId),
    ]);
  // Prefer a linked account's friendly nickname (set in
  // /settings/accounts) over the raw one-time-copied Debt.name — see
  // WORKING_ON.md's 2026-08-15 account-settings consolidation entry.
  // accountRawName/accountOrgName are captured separately, before `name`
  // gets overwritten above — logo matching (debt-row.tsx) also searches
  // them, via debtLogoSearchText's own tiering (raw name first, orgName
  // only as a last resort — see its comment: orgName isn't reliably
  // accurate on its own, a real household's Discover card reports it as
  // "Capital One"). Never shown as text.
  const debts = rawDebts.map((d) => ({
    ...d,
    accountRawName: d.account?.name ?? null,
    accountOrgName: d.account?.orgName ?? null,
    name: d.account?.displayName ?? d.name,
  }));

  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  // UTC start of the previous calendar month — [lastMonthStart, monthStart) is
  // "last month," feeding the Payoff Calendar's look-back page (see
  // CycleMinimum.lastMonthPayments).
  const lastMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));

  // Every read below depends only on the debt list — one round trip, not
  // eight in a row.
  const [
    debtsNeedingSetup,
    debtPayments,
    pendingReviews,
    debtPatterns,
    rawPayoffSnapshots,
    supersededPayoffExtra,
    minimumSkipRows,
    planExtrasByDebtId,
  ] = await Promise.all([
    isOwner ? getActiveDebtsNeedingSetup(session.user.householdId) : [],
    db.debtPayment.findMany({
      where: { householdId: session.user.householdId, debtId: { in: debts.map((d) => d.id) }, active: true },
      select: {
        id: true,
        debtId: true,
        amountCents: true,
        amountDueCents: true,
        cadence: true,
        nextDueDate: true,
        lastPaidDate: true,
        cycleRestartDueDate: true,
        dueDateLocked: true,
        createdAt: true,
        payments: { where: recentPaymentsWhere(), select: { id: true, amountCents: true, occurredOn: true, pending: true } },
      },
    }),
    // A REVOLVING debt "needs setup" — badged on its row and (see
    // app-shell.tsx) the Debts nav tab — until a human has confirmed its
    // terms and due date, or if a payment's asking to confirm a minimum
    // change. INSTALLMENT/BNPL debts never carry a DebtPayment at all, so
    // they're never flagged.
    db.debtAmountReview.findMany({
      where: { householdId: session.user.householdId },
      select: { debtPayment: { select: { debtId: true } } },
    }),
    db.recurringPattern.findMany({
      where: { householdId: session.user.householdId, direction: "DEBIT", debtId: { in: debts.map((d) => d.id) } },
      select: { debtId: true },
    }),
    db.payoffExtraSnapshot.findMany({
      where: { householdId: session.user.householdId, isPayoff: true, dueDate: { gte: lastMonthStart, lt: monthEnd } },
      select: { debtId: true, dueDate: true, amountCents: true },
      // See payoffSnapshots below for why this is ordered.
      orderBy: { weekStart: "asc" },
    }),
    supersededPayoffExtraByDebtInPeriod(session.user.householdId, monthStart, monthEnd),
    db.debtMinimumSkip.findMany({
      where: { householdId: session.user.householdId, dueDate: { gte: lastMonthStart, lt: monthEnd } },
      select: { debtId: true, dueDate: true },
    }),
    // Planned payoff-plan extras for this month and last (the Last Month
    // list page uses the same split) — see splitPlanExtraPayments.
    planExtraTargetsByDebt(session.user.householdId, lastMonthStart, monthEnd),
  ]);
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));

  const debtPaymentByDebtId = new Map(debtPayments.map((p) => [p.debtId, p]));

  // Debt-targeted P2P patterns (a Venmo/Zelle payment classified straight
  // to a debt, no bucket) have no page of their own to surface on the way
  // a bucket-targeted pattern shows on its bucket's page — DebtRow gets a
  // compact count+link instead, editing happens via the Repeat badge on
  // one of the debt's own matched transactions (/transactions).
  const patternCountByDebtId = new Map<string, number>();
  for (const p of debtPatterns) {
    if (!p.debtId) continue;
    patternCountByDebtId.set(p.debtId, (patternCountByDebtId.get(p.debtId) ?? 0) + 1);
  }

  function needsSetup(d: (typeof debts)[number]): boolean {
    const payment = debtPaymentByDebtId.get(d.id);
    return debtNeedsSetup(d, payment?.dueDateLocked ?? null, debtIdsWithPendingReview.has(d.id));
  }

  // Suggest a likely account match for each unlinked debt (e.g. a debt named
  // "Chase Sapphire" next to a synced "Chase Sapphire Visa" credit card
  // account) so linking is a one-click confirm instead of a blind dropdown.
  const linkedAccountIds = new Set(debts.map((d) => d.accountId).filter((id): id is string => Boolean(id)));
  const linkCandidates = accounts.filter(
    (a) => (a.accountType === "CREDIT_CARD" || a.accountType === "LOAN") && !linkedAccountIds.has(a.id),
  );
  const suggestedAccountByDebtId = new Map<string, { id: string; name: string }>();
  for (const d of debts) {
    if (d.accountId) continue;
    let best: { id: string; name: string; score: number } | null = null;
    for (const a of linkCandidates) {
      // Matched against the raw synced name/org (closer to what a bank
      // actually calls it, so more likely to resemble the debt's own name)
      // — only the *displayed* label prefers the household's own friendly
      // name (Account.displayName), same "just the friendly name" rule
      // every other account reference in the app follows.
      const score = Math.max(nameSimilarity(d.name, a.name), nameSimilarity(d.name, a.orgName ?? ""));
      if (score >= 0.34 && (!best || score > best.score)) best = { id: a.id, name: a.displayName ?? a.name, score };
    }
    if (best) suggestedAccountByDebtId.set(d.id, { id: best.id, name: best.name });
  }

  // Every isPayoff PayoffExtraSnapshot row landing in this month or last —
  // PayoffPlanner's own calendar prefers this over Debt.paidOffDate for a
  // balance-only payoff's fallback line (see its own comment): the plan's
  // recorded expected date, not whenever a balance sync happened to notice.
  // A debt whose balance comes back after a projected payoff (paid off,
  // then restored) can leave more than one isPayoff row in the same month —
  // the pre-restoration projection plus the plan's current one. The query
  // above orders them ascending so the Map builds below (last write wins,
  // keyed by debtId/debtId+month) always keep the most recent projection.
  const payoffSnapshots = rawPayoffSnapshots.map((s) => ({ debtId: s.debtId, dueDate: s.dueDate.toISOString().slice(0, 10), amountCents: s.amountCents }));

  // Per-debt real extra money this month that already retired a payoff target
  // the live plan has since dropped — subtracted before PayoffPlanner walks
  // its projected lines, so a debt that closed and reopened in the same month
  // doesn't double-credit the old payment against the new target. Computed
  // server-side (the snapshot rows' weekStart never crosses to the client) and
  // shipped down as a plain Record, same as payoffSnapshots above. See
  // supersededPayoffExtraCents, src/lib/debt-payoff.ts.
  const supersededPayoffExtraByDebtId = Object.fromEntries(supersededPayoffExtra);

  // Household-skipped covered minimums this month (DebtMinimumSkip) — keyed
  // per debt as ISO due dates for DebtRow's ledger (resolveMinimumLedger).
  // Last month's too, for the Payoff Calendar's "Last Month" list page
  // (lastMonthCycleMinimum below).
  const skippedMinimumDatesByDebtId = new Map<string, string[]>();
  const lastMonthSkippedMinimumDatesByDebtId = new Map<string, string[]>();
  for (const r of minimumSkipRows) {
    const byDebt = r.dueDate < monthStart ? lastMonthSkippedMinimumDatesByDebtId : skippedMinimumDatesByDebtId;
    const list = byDebt.get(r.debtId) ?? [];
    list.push(r.dueDate.toISOString().slice(0, 10));
    byDebt.set(r.debtId, list);
  }


  const plannerDebts: PlannerDebt[] = debts.map((d) => {
    const payment = debtPaymentByDebtId.get(d.id);
    // "This cycle" is the real current calendar month (household correction,
    // 2026-08-25 — see debt-row.tsx's CycleMinimum comment), not one
    // cadence-length window ending at the due date. buildCycleSlots
    // (src/lib/cycle-slots.ts, the same primitive Buckets already uses for
    // its own due-date-aware pace math) finds every expected occurrence of
    // this debt's cadence landing in [monthStart, monthEnd) and pairs it
    // positionally against real payments in that same window.
    const paymentsAbs = payment
      ? // A card/loan payment can post on the debt's own liability account
        // as a negative credit (see filterDebtPaymentTwins, debt-payments.ts)
        // — this ledger always shows "amount paid," never the account-native
        // sign.
        payment.payments.map((p) => ({ id: p.id, amountCents: Math.abs(p.amountCents), occurredOn: p.occurredOn, pending: p.pending }))
      : [];
    // occurrencesInPeriod walks backward from nextDueDate assuming the
    // cadence has held uniformly forever — true for a REVOLVING billing
    // cycle, false for an INSTALLMENT/BNPL plan's first installment, which
    // fires at purchase on whatever irregular date the household actually
    // bought the thing (see matchInstallmentPayments' own comment on this).
    // Left unclamped, a plan purchased mid-cycle projects a phantom
    // pre-purchase "expected occurrence" one cadence before its real first
    // payment (a real Klarna plan purchased Aug 18, BIWEEKLY, next due Sep
    // 3, backward-walked to a phantom Aug 6 alongside the real Aug 20 slot)
    // — and since buildCycleSlots pairs slots against payments positionally,
    // not by date, the one real Aug 20 payment then lands on the phantom
    // Aug 6 slot, leaving the genuine Aug 20 slot rendering as still open
    // despite already being paid. Anchoring the walk's lower bound at the
    // purchase date (never earlier than this month) keeps it from reaching
    // before the plan existed.
    // See slotBounds: INSTALLMENT gets a hard purchase-date floor (a
    // pre-purchase occurrence never existed); a REVOLVING card/loan's
    // occurrences are all real (the debt predates the auto-created tracker)
    // — only an *unpaid* pre-createdAt one is hidden as a phantom, while a
    // real payment linked to one still reads "Minimum … — paid".
    // A paid payoff-plan extra (matched to its payday's planned figure) never
    // fills a minimum slot — see splitPlanExtraPayments (cycle-slots.ts).
    const { planExtraPayments, rest: slotPayments } = splitPlanExtraPayments(
      paymentsAbs,
      planExtrasByDebtId.get(d.id) ?? [],
    );
    const withPlanExtras = (
      period: { slots: { date: Date; payment: (typeof paymentsAbs)[number] | null }[]; extraPayments: typeof paymentsAbs },
      periodStart: Date,
      periodEnd: Date,
    ) => ({
      slots: period.slots,
      extraPayments: [
        ...planExtraPayments.filter((t) => t.occurredOn >= periodStart && t.occurredOn < periodEnd),
        ...period.extraPayments,
      ].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime()),
    });
    const slotsForPeriod = (periodStart: Date, periodEnd: Date) =>
      payment
        ? withPlanExtras(buildCycleSlots(
            payment.nextDueDate,
            payment.cadence,
            periodStart,
            periodEnd,
            slotPayments,
            slotBounds(periodStart, {
              debtType: d.debtType,
              purchaseDate: d.purchaseDate,
              trackerCreatedAt: payment.createdAt,
              cadence: payment.cadence,
              nextDueDate: payment.nextDueDate,
              lastPaidDate: payment.lastPaidDate,
              installmentsRemaining: d.installmentsRemaining,
        cycleRestartDueDate: payment.cycleRestartDueDate,
            }),
          ), periodStart, periodEnd)
        : { slots: [], extraPayments: [] };
    let { slots, extraPayments } = slotsForPeriod(monthStart, monthEnd);
    // The real payments-beyond-the-expected-slot-count figure, untouched by
    // the ignoreMinimumPayment display fold below — the same thing
    // src/lib/debt-payments.ts's correctedDueDateByDebtId computes
    // server-side (extraPaidCents) for the dashboard/buckets, and what
    // payoff-planner.tsx's extraPaidThisCycleByDebtId must match so a real
    // payment isn't double-counted against the projected payoff-plan extra.
    // For a no-minimum debt, folding its one slot-consuming payment into
    // `extraPayments` below (for ledger display) would otherwise leak into
    // that net-against-the-projection figure as a phantom "extra" — a real
    // household report, 2026-09-04: Sam's Club's Sept 1 payment satisfied
    // its one MONTHLY slot, but /debts read it as $101 of *extra* progress
    // and shrank the still-pending plan payoff from $140.80 to $39.80,
    // diverging from the dashboard/buckets figures (which correctly showed
    // the $101 as a separately-settled row and the full $140.80 still
    // pending).
    // Shared with src/lib/debt-payments.ts's correctedDueDateByDebtId (see
    // extraPaymentsBeyondSlots' own comment, cycle-slots.ts) — one
    // implementation of "once a debt pays off this month, its whole month
    // counts as extra" so this and the dashboard/payoff-planner can't drift
    // apart the way they already have once (2026-09-06, Quicksilver payoff).
    const extraPaymentsBeyondSlots = resolveExtraPaymentsBeyondSlots(extraPayments, paymentsAbs, monthStart, monthEnd, {
      paidOffDate: d.paidOffDate,
      tracksMinimum: payment ? tracksMinimum(d, payment) : !d.ignoreMinimumPayment,
    });
    // A no-minimum debt (ignoreMinimumPayment — a card the household pays
    // ad hoc) has no "Minimum … due/paid" concept: fold every paired payment
    // into the flat list so the ledger lists each one as "· Extra" (every
    // dollar on this debt is discretionary / above a required minimum),
    // never as a "Minimum $0.00" line.
    const foldNoMinimum = (period: { slots: typeof slots; extraPayments: typeof extraPayments }) =>
      payment && d.ignoreMinimumPayment
        ? {
            slots: [],
            extraPayments: [...period.slots.flatMap((s) => (s.payment ? [s.payment] : [])), ...period.extraPayments].sort(
              (a, b) => a.occurredOn.getTime() - b.occurredOn.getTime(),
            ),
          }
        : period;
    ({ slots, extraPayments } = foldNoMinimum({ slots, extraPayments }));
    const cycleMinimum: CycleMinimum | null = payment
      ? {
          debtPaymentId: payment.id,
          amountCents: payment.amountCents,
          amountDueCents: payment.amountDueCents,
          // Normally payment.nextDueDate itself lands in this period — but
          // the rolling-balance rework (matchDebtPayments, 2026-08-26) now
          // advances nextDueDate on a blind schedule regardless of whether
          // the debt was ever actually paid, so a debt with an unmatched
          // backlog can have nextDueDate already sitting a cycle or more
          // *past* this period while the real unresolved slot is still here
          // (real case, 2026-08-26: Personal loan, zero synced payments ever
          // matched, nextDueDate rolled to Sept 25 while Aug 25 sits unpaid —
          // pointing "due" at Sept 25 dropped it off the Payoff Calendar
          // entirely and threw off the cascading extra-payment projection,
          // which keys off this same date via dueDateByDebtId). The first
          // still-unpaid occurrence in this period (cycleDueDate — the same
          // rule the server calendars use); nextDueDate only when nothing's
          // expected this period at all (e.g. an ANNUAL debt due in a
          // different month).
          dueDate: cycleDueDate(slots, payment.nextDueDate),
          nextDueDate: payment.nextDueDate,
          // Whether the tracked next due date actually lands in the current
          // calendar month. An empty `slots` list means it doesn't — the
          // tracker's next occurrence is a *future* month (a synced/hand-added
          // debt whose first due date is next month, a caught-up debt rolled
          // forward, or an ANNUAL debt due later in the year). The "This Month"
          // ledger's fallback "Next due …" line keys off this so next month's
          // date stops leaking into a view that should only show this month's
          // payments and expected payments (repeat household report, 2026-08-30).
          nextDueThisMonth: payment.nextDueDate >= monthStart && payment.nextDueDate < monthEnd,
          cadence: payment.cadence,
          // Vacuously true when nothing's expected this month at all (empty
          // array's .every() — e.g. an ANNUAL debt due in a different month).
          paidThisCycle: slots.every((s) => s.payment !== null),
          dueDateLocked: payment.dueDateLocked,
          payments: paymentsAbs.filter((p) => p.occurredOn >= monthStart && p.occurredOn < monthEnd),
          lastMonthPayments: paymentsAbs.filter((p) => p.occurredOn >= lastMonthStart && p.occurredOn < monthStart),
          slots,
          extraPayments,
          extraPaymentsBeyondSlots,
          planExtraPaymentIds: planExtraPayments.map((t) => t.id),
          skippedSlotDates: skippedMinimumDatesByDebtId.get(d.id) ?? [],
        }
      : null;
    // The same ledger, scoped to last calendar month — the Payoff Calendar's
    // "Last Month" list page, which exists so a covered minimum whose due
    // date already rolled into last month (Venture's $84 due Sep 27, covered
    // by a $177 Sep 18 payment, still listed on Oct 2) can still be skipped
    // (household request, 2026-10-02). Display + skip only: no projections,
    // no extras, nothing feeds the plan from this.
    const lastMonth = foldNoMinimum(slotsForPeriod(lastMonthStart, monthStart));
    const lastMonthCycleMinimum: CycleMinimum | null =
      payment && cycleMinimum
        ? {
            ...cycleMinimum,
            dueDate: cycleDueDate(lastMonth.slots, payment.nextDueDate),
            // "this month" here means the viewed month — ledgerMinimumCents
            // must still see arrears when the tracker hasn't rolled out of it.
            nextDueThisMonth: payment.nextDueDate >= lastMonthStart && payment.nextDueDate < monthStart,
            paidThisCycle: lastMonth.slots.every((s) => s.payment !== null),
            payments: cycleMinimum.lastMonthPayments,
            slots: lastMonth.slots,
            extraPayments: lastMonth.extraPayments,
            extraPaymentsBeyondSlots: [],
            skippedSlotDates: lastMonthSkippedMinimumDatesByDebtId.get(d.id) ?? [],
          }
        : null;
    return {
      id: d.id,
      name: d.name,
      label: d.label,
      balanceCents: d.balanceCents,
      aprBasisPoints: d.aprBasisPoints,
      minPaymentCents: d.minPaymentCents,
      freedMinimumCents: d.freedMinimumCents,
      ignoreMinimumPayment: d.ignoreMinimumPayment,
      debtType: d.debtType,
      kind: d.kind,
      installmentsTotal: d.installmentsTotal,
      installmentsRemaining: d.installmentsRemaining,
      receiptItems: (d.receiptItems as PlannerDebt["receiptItems"]) ?? null,
      receiptTotalCents: d.receiptTotalCents,
      source: d.source,
      accountId: d.accountId,
      paidOffDate: d.paidOffDate,
      paidOffAmountCents: d.paidOffAmountCents,
      includeInPayoffPlan: d.includeInPayoffPlan,
      hiddenAt: d.hiddenAt,
      suggestedAccount: suggestedAccountByDebtId.get(d.id) ?? null,
      needsSetup: needsSetup(d),
      patternCount: patternCountByDebtId.get(d.id) ?? 0,
      cycleMinimum,
      lastMonthCycleMinimum,
      accountRawName: d.accountRawName,
      accountOrgName: d.accountOrgName,
    };
  });

  const totalBalanceCents = debts.reduce((s, d) => s + d.balanceCents, 0);
  const activeCount = debts.filter((d) => d.balanceCents > 0).length;
  const allDebtsPaidOff = debts.length > 0 && activeCount === 0;

  // Snapshot today's total (upserted — see recordDebtSnapshot), then read
  // back the month-to-date trend for the collapsed card, same convention as
  // net worth's trend line (src/lib/networth-history.ts).
  const [, debtTrend] = await Promise.all([
    recordDebtSnapshot(session.user.householdId, totalBalanceCents),
    getDebtTrend(session.user.householdId, totalBalanceCents),
  ]);

  return (
    <AppShell
      title="Debt Payoff"
      user={session.user}
      width="wide"
      titleActions={
        <Link
          href="/settings/accounts"
          aria-label="Account Settings"
          title="Account Settings — track a newly connected card/loan, rename accounts, add/edit/delete manual debts, edit interest/minimum payment/due date"
          className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          <Settings size={18} />
        </Link>
      }
    >
      {/* The alerts stay a readable single column, capped and centered like
          the dashboard's own alert stack — sequential notices, not a card
          meant to spread out. TotalDebtCard is handed to PayoffPlanner
          instead of rendered here, so it can sit side by side with the
          Payoff Strategy card on desktop (see PayoffPlanner's own comment on
          why). */}
      <div className="flex flex-col gap-6 lg:mx-auto lg:max-w-3xl">
        {isOwner && <DebtAmountReviewCard reviews={pendingDebtAmountReviews} />}
        {isOwner && <DebtBalanceReviewCard reviews={pendingDebtBalanceReviews} />}

        <NeedsSetupWarning debts={debtsNeedingSetup} />

        <MinPaymentWarning debts={insufficientMinimumDebts} />

        <BillSuggestions
          suggestions={debtSuggestions.map((s) => ({
            ...s,
            nextDueDate: s.nextDueDate.toISOString().slice(0, 10),
            lastSeenDate: s.lastSeenDate.toISOString().slice(0, 10),
          }))}
          buckets={[]}
          categories={categories}
        />
      </div>

      {debts.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400 lg:mx-auto lg:max-w-3xl">No debts tracked yet — add one below.</p>
      ) : (
        <PayoffPlanner
          debts={plannerDebts}
          initialOrder={household.payoffOrder as PayoffOrder}
          initialExtraDollars={household.payoffExtraCents / 100}
          initialRollFreedMinimums={household.payoffRollFreedMinimums}
          initialRollFreedMinimumsSplit={household.payoffRollFreedMinimumsSplit}
          initialEnabled={household.payoffPlanEnabled}
          income={income}
          isOwner={isOwner}
          payoffExtraSkips={payoffExtraSkips}
          payoffSnapshots={payoffSnapshots}
          supersededPayoffExtraByDebtId={supersededPayoffExtraByDebtId}
          todayISO={todayAsUTCDate().toISOString().slice(0, 10)}
          totalDebtCard={
            <TotalDebtCard
              debts={debts.map((d) => ({
                id: d.id,
                name: d.name,
                balanceCents: d.balanceCents,
                aprBasisPoints: d.aprBasisPoints,
                debtType: d.debtType,
                kind: d.kind,
              }))}
              totalBalanceCents={totalBalanceCents}
              allDebtsPaidOff={allDebtsPaidOff}
              trend={debtTrend}
            />
          }
        />
      )}
    </AppShell>
  );
}
