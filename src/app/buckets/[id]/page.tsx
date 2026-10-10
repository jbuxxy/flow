import { redirect, notFound } from "next/navigation";
import { PAYMENT_RECEIPT_SELECT } from "@/lib/payment-receipt";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getBucketsWithProgress } from "@/lib/buckets";
import { currentPeriodBillWhere, getActiveBillCycleSkips } from "@/lib/recurring-bills";
import {
  spendEntriesFrom,
  spendMerchantKey,
  ACCOUNTED_FOR_SELECT,
  accountedForCents,
} from "@/lib/spend";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { occurrencesInPeriod } from "@/lib/cycle-slots";
import { getLabelSuggestionsByMerchant } from "@/lib/transaction-labels";
import { getReimbursementSuggestions } from "@/lib/reimbursements";
import {
  getAccountedForSuggestions,
  isPayoffPlanEnabled,
} from "@/lib/debt-payments";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { AppShell } from "@/components/app-shell";
import { scheduleBucketIcons } from "@/lib/bucket-icons-sync";
import { billCardInclude, buildBillCards, buildDebtPaymentCards, debtPaymentCardInclude } from "@/lib/recurring-cards";
import { BucketProgressBar } from "@/components/bucket-progress-bar";
import { SwipeCarousel } from "@/components/swipe-carousel";
import { SinglesList, type SinglesRow } from "./singles-list";
import type { ReceiptLineItem } from "@/app/transactions/transaction-row";
import { BucketBillsSection } from "./bucket-bills-section";
import { spendBreakdownCards, spendBreakdownLabelOrder, type SpendEntry } from "./bucket-spend-breakdown";
import { serializePatternDates, type PatternData } from "@/lib/pattern-data";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { BucketEntryFilterProvider, ActiveEntryFilterSummary } from "@/components/bucket-entry-filter";
import { BucketTitleSettings } from "./bucket-title-settings";
import type { BucketAlertOverridesByUser } from "./bucket-settings-form";
import type { BucketAlertOverrideType } from "./actions";
import { defaultNotificationEnabled } from "@/lib/notification-preferences";
import { belongsToHousehold } from "@/lib/access";

export default async function BucketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  // Resolve any not-yet-iconed bucket first (no-op after the first run for
  // this household) so the row loaded just below carries a fresh icon key.
  scheduleBucketIcons(session.user.householdId);
  const bucket = await db.bucket.findUnique({ where: { id } });
  if (!belongsToHousehold(bucket, session.user.householdId)) notFound();

  const isOwner = session.user.role === "OWNER";
  // Every household member (for the owner-only per-bucket alert "Notify"
  // picker) and this bucket's existing locks, reshaped userId -> type ->
  // ALWAYS/NEVER — see BucketAlertOverridesByUser (bucket-settings-form.tsx).
  const [householdMembers, bucketAlertOverrideRows] = await Promise.all([
    db.user
      .findMany({
        where: { householdId: session.user.householdId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          role: true,
          dashboardScope: true,
          notificationsEnabled: true,
          notificationPreferences: {
            where: { type: { in: ["BUCKET_PACE", "WEEKLY_BUCKET_REPORT", "BUCKET_TRANSACTION"] } },
            select: { type: true, enabled: true },
          },
        },
      })
      .then((rows) =>
        rows.map((r) => {
          // Each member's own answer for each bucket alert type when nothing
          // is locked here — their saved preference (or its role default),
          // and nothing at all with their master switch off. This is the
          // position an unlocked switch in BucketAlertRecipients shows.
          const personal = {} as Record<BucketAlertOverrideType, boolean>;
          for (const type of ["BUCKET_PACE", "WEEKLY_BUCKET_REPORT", "BUCKET_TRANSACTION"] as const) {
            const saved = r.notificationPreferences.find((p) => p.type === type)?.enabled;
            personal[type] = r.notificationsEnabled && (saved ?? defaultNotificationEnabled(r, type));
          }
          return { id: r.id, name: r.name ?? "Pending Invite", personal };
        }),
      ),
    db.bucketAlertOverride.findMany({
      where: { bucketId: bucket.id },
      select: { userId: true, type: true, override: true },
    }),
  ]);
  const bucketAlertOverrides: BucketAlertOverridesByUser = {};
  for (const row of bucketAlertOverrideRows) {
    // setBucketAlertOverride only ever writes one of the three
    // BucketAlertOverrideType values here — this cast just names that
    // already-true invariant for the type checker, since Prisma's own
    // column type is the broader NotificationType enum.
    (bucketAlertOverrides[row.userId] ??= {})[row.type as BucketAlertOverrideType] = row.override;
  }

  // UTC bounds, not local periodBounds — every date compared against these
  // (Transaction.occurredOn, DebtPayment.nextDueDate) is a UTC-midnight
  // @db.Date (see utcPeriodBounds's own doc comment; this file used local
  // bounds for these same comparisons until a 2026-09-11 fix — the
  // household's local calendar day is still the source of truth for "which
  // day," but a stored @db.Date already encodes that and must be read back
  // via UTC getters/bounds to line up correctly).
  const { start, end } = utcPeriodBounds(currentPeriodKey());
  // A one-time-purchase bucket accumulates toward a target across months (see
  // getBucketsWithProgress) — its transaction list has to match that, not
  // reset to just this month's charges, or the list contradicts the bar.
  const txPeriodWhere = bucket.excludedFromAllocation ? {} : { occurredOn: { gte: start, lt: end } };
  const transactions = await db.transaction.findMany({
    where: { bucketId: bucket.id, ...txPeriodWhere },
    // Stable within-day tiebreaker — occurredOn is date-only, so without it a
    // just-edited row can jump to the top of its day (see transactions/page.tsx).
    orderBy: [{ occurredOn: "desc" }, { createdAt: "asc" }, { id: "asc" }],
    include: {
      reimbursesTransaction: { select: { id: true, merchant: true, amountCents: true, occurredOn: true } },
      // Every credit that offsets this charge, whenever it posted — the
      // spend breakdown nets a refund against the charge's own month/
      // category, not the month the refund landed (see src/lib/spend.ts).
      reimbursedBy: { select: { amountCents: true } },
      // Partial-amount offsets (a split income credit earmarked against this
      // charge) — netted the same way as reimbursedBy. See TransactionOffset.
      offsetsAsDebit: { select: { amountCents: true } },
      // A debt-payment or *unscheduled* P2P-pattern transaction can still
      // carry its own bucketId (the "spend-and-payoff card" case — see the
      // schema comment on Transaction.accountedForLinks), so it
      // can land in this page's Singles list too — label/debtType feed the
      // same effective-label precedence /transactions uses below (2026-08-25
      // consolidation: an INSTALLMENT debt's or a pattern's own label is the
      // single source of truth for its linked payments, not a
      // separately-tracked Transaction.label copy). A *scheduled* pattern
      // (cadence set) is the exception, excluded below the same way a
      // billId match already is — see unbilledTransactions' own comment.
      debt: { select: { label: true, debtType: true } },
      pattern: { select: { label: true, cadence: true } },
      // Drives the small receipt glyph in the Singles row title, same as
      // /transactions' own TransactionRow. occurredOn/receivedAt feed the
      // "From Receipt" block's bare-match fallback line.
      receipt: { select: { id: true, occurredOn: true, receivedAt: true } },
    },
  });

  const [
    allBuckets,
    debts,
    categories,
    bills,
    debtPayments,
    patterns,
    pendingReviews,
    debtPaymentSpend,
    payoffPlanEnabled,
  ] = await Promise.all([
      getBucketsWithProgress(session.user.householdId, { includeBucketId: bucket.id }),
      db.debt.findMany({
        // Hidden debts / paid-off loans must not resurface as a Reclassify
        // target in the Singles list — see pickableDebtWhere.
        where: { householdId: session.user.householdId, ...pickableDebtWhere() },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, account: { select: { orgName: true, displayName: true } } },
      }),
      // Full household list, not scoped to this bucket alone — most uses on
      // this page (BucketBillsSection, CategoryManager) filter it down to
      // just this bucket's own categories (see the schema comment on
      // BillCategory.bucketId), but the Singles list's own Reclassify can
      // move a transaction to any *other* bucket, which needs to see that
      // bucket's categories too — filtered client-side there instead.
      db.billCategory.findMany({
        where: { householdId: session.user.householdId },
        select: { id: true, name: true, bucketId: true },
        orderBy: { name: "asc" },
      }),
      db.recurringBill.findMany({
        where: { householdId: session.user.householdId, bucketId: bucket.id, ...currentPeriodBillWhere() },
        orderBy: { nextDueDate: "asc" },
        include: billCardInclude(),
      }),
      // Purely a display grouping (see the schema comment on
      // DebtPayment.bucketId) — a debt payment assigned to this bucket
      // shows here too, alongside RecurringBills, without joining the
      // bucket's own spend/budget math (see BucketBillsSection).
      db.debtPayment.findMany({
        // hiddenFromBucket excludes anything a household hid while it sat
        // at $0 (see hideDebt, debts/actions.ts) — self-clears the moment
        // the debt's balance goes positive again, so nothing here needs to
        // re-check that on its own.
        where: { householdId: session.user.householdId, bucketId: bucket.id, active: true, hiddenFromBucket: false },
        orderBy: { nextDueDate: "asc" },
        include: debtPaymentCardInclude(),
      }),
      // Recurring P2P activity (weekly training, monthly dance/preschool —
      // amount range + optional weekday/day-of-month hints, see
      // RecurringPattern's schema comment) targeting this bucket — shown
      // and editable here too (reusing /transfers' own PatternRow), not
      // just from the /transfers page, since a household managing a
      // bucket's recurring spend shouldn't have to leave it to find the
      // pattern that's filing into it.
      db.recurringPattern.findMany({
        where: {
          householdId: session.user.householdId,
          direction: "DEBIT",
          bucketId: bucket.id,
          ...currentPeriodPatternWhere(),
        },
        include: {
          category: { select: { name: true } },
          transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, pending: true, ...PAYMENT_RECEIPT_SELECT } },
        },
        orderBy: { label: "asc" },
      }),
      db.debtAmountReview.findMany({
        where: { householdId: session.user.householdId },
        select: { debtPayment: { select: { debtId: true } } },
      }),
      // A debt payment's own Transaction.bucketId is always null (mutual-
      // exclusion: bucketId vs. debtId+isTransfer, see WORKING_ON.md's core
      // data conventions) — only debtPaymentId + DebtPayment.bucketId link
      // it to this bucket, so it never shows up in the plain `transactions`
      // query above. Fetched separately, same shape/exclusion logic as
      // getBucketsWithProgress's own debtPaymentTxns query (src/lib/
      // buckets.ts), so this bucket's real spend-by-category/merchant
      // breakdown below (spendEntries) actually includes e.g. a mortgage or
      // loan payment instead of silently missing it (2026-08-24, caught by
      // the household noticing "Mortgage/Rent" absent from the breakdown).
      db.transaction.findMany({
        where: {
          householdId: session.user.householdId,
          debtPaymentId: { not: null },
          debtPayment: { bucketId: bucket.id },
          occurredOn: { gte: start, lt: end },
        },
        select: {
          amountCents: true,
          occurredOn: true,
          merchant: true,
          debtPaymentId: true,
          debtPayment: {
            select: {
              amountCents: true,
              cadence: true,
              nextDueDate: true,
              category: { select: { name: true } },
              debt: { select: { name: true, account: { select: { displayName: true } } } },
            },
          },
          ...ACCOUNTED_FOR_SELECT,
        },
      }),
      isPayoffPlanEnabled(session.user.householdId),
    ]);
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));
  // Was prefixed with the synced account's institution to disambiguate
  // generic-sounding lender names — dropped per feedback (2026-08-18): just
  // the friendly name, same as every other debt reference in the app
  // (WORKING_ON.md), same reasoning as transactions/page.tsx's debtOptions.
  const debtOptions = debts.map((d) => ({ id: d.id, name: d.account?.displayName ?? d.name }));
  const progress = allBuckets.find((b) => b.id === bucket.id)!;
  // Includes this bucket itself (marked Current in the row's dropdown) so a
  // Single can have just its category changed without being forced into a
  // different bucket — RECURRING buckets stay out (bucketId can't be set on
  // one directly, see reassignTransaction's guard).
  const reassignBuckets = allBuckets
    .filter((b) => b.trackingMode !== "RECURRING")
    .map((b) => ({ id: b.id, name: b.name, trackingMode: b.trackingMode }));
  // A transaction linked to a tracked bill already has its own card in
  // BucketBillsSection above (with its own due/paid status) — listing it
  // again here would just be the same payment shown twice. A *scheduled*
  // RecurringPattern match (cadence set) is the same story now that it
  // renders its own bill-style EntryLine/CycleLedger card too (real report,
  // 2026-09-11: a scheduled pattern's payment showed once in its own
  // recurring card and again as a plain Singles row). An *unscheduled*
  // pattern still has no per-payment card of its own to point to — its
  // matched transaction stays in Singles, same as before this existed.
  const unbilledTransactions = transactions.filter((t) => !t.billId && !(t.patternId && t.pattern?.cadence));
  // A RECURRING bucket has no Singles list — but a charge that landed here
  // and never matched a tracked bill (a duplicate, a cancelled plan's final
  // charge, a mid-cycle plan change) would otherwise be invisible and
  // impossible to act on, showing only as an un-clickable "Uncategorized"
  // slice of the spend breakdown. Surface those specifically. Reimbursement
  // credits are excluded — they belong to a bill's own reimbursement linker.
  const orphanTransactions =
    bucket.trackingMode === "RECURRING" ? unbilledTransactions.filter((t) => !t.reimbursesTransactionId) : [];
  // The transactions the on-page list actually renders: every unbilled one
  // for SPEND/MIXED ("Singles"), just the orphans for RECURRING.
  const singlesTransactions = bucket.trackingMode === "RECURRING" ? orphanTransactions : unbilledTransactions;
  // Only a budget-tracked debt account has purchases to double-count
  // against in the first place (see DebtPaymentRow's accountBudgetTracked
  // gate) — no point computing suggestions for payments the linker never
  // renders for. A payment already fully covered by its existing links (the
  // household picked "no, just a payment", or its links already sum to the
  // full amount) doesn't need a fresh suggestion list either — but one with
  // only a *partial* match still does, so a second purchase can be added.
  const accountedForCandidates = debtPayments
    .filter((p) => p.debt.account?.budgetTracked)
    .flatMap((p) =>
      p.payments
        // This month's only — see the identical bound on bills/page.tsx.
        .filter((t) => t.occurredOn >= start && !t.notAccountedFor && accountedForCents(t) < Math.abs(t.amountCents))
        .map((t) => ({
          id: t.id,
          debtId: p.debtId,
          amountCents: t.amountCents,
          occurredOn: t.occurredOn,
          alreadyLinkedCents: accountedForCents(t),
        })),
    );
  // Amount-bounded merchant rules routing *into* this bucket ("only send
  // QuikStop under $15 here") — surfaced in the bucket settings modal so
  // they're visible and removable, not a silent mystery when a small
  // charge lands somewhere unexpected.
  const [amountRoutingRules, labelSuggestions, reimbursementSuggestions, accountedForSuggestions, activeBillSkips] =
    await Promise.all([
      db.merchantRule.findMany({
        where: { householdId: session.user.householdId, bucketId: bucket.id, amountMinCents: { not: null } },
        select: { id: true, merchant: true, amountMinCents: true, amountMaxCents: true },
        orderBy: { merchant: "asc" },
      }),
      getLabelSuggestionsByMerchant(session.user.householdId, transactions.map((t) => t.merchant)),
      getReimbursementSuggestions(
        session.user.householdId,
        unbilledTransactions.filter((t) => t.amountCents < 0 && !t.reimbursesTransactionId),
      ),
      getAccountedForSuggestions(session.user.householdId, accountedForCandidates),
      getActiveBillCycleSkips(session.user.householdId, bills),
    ]);

  // This bucket's own categories only — everything on this page that always
  // belongs to this one bucket (its bills, its own category manager, its
  // spend breakdown) uses this; the Singles list and the DEBIT pattern
  // editor below use the full `categories` list instead since either can
  // target a *different* bucket, filtering client-side by whichever one is
  // currently selected (see the schema comment on BillCategory.bucketId).
  const bucketCategories = categories.filter((c) => c.bucketId === bucket.id);

  const mappedBills = buildBillCards(bills, activeBillSkips, start, end);

  // "This cycle" is the real current calendar month (household correction,
  // 2026-08-25 — see debt-row.tsx's CycleMinimum comment), computed via the
  // same buildCycleSlots primitive debts/page.tsx uses. UTC bounds, not the
  // local `periodBounds` above — nextDueDate/occurredOn on a DebtPayment's
  // ledger are `@db.Date` (UTC midnight), see utcPeriodBounds's own comment.
  const { start: utcMonthStart, end: utcMonthEnd } = utcPeriodBounds(currentPeriodKey());
  const utcMonthStartISO = utcMonthStart.toISOString().slice(0, 10);
  const utcMonthEndISO = utcMonthEnd.toISOString().slice(0, 10);

  // Dated payoff-plan "extra toward principal" lines landing this calendar
  // month, per debt — the projected emerald EntryLines the debt payment card
  // renders in its ledger, mirroring DebtRow's expectedExtras on /debts. The
  // matching cents total already feeds the bucket's budgeted-spend ceiling
  // via plannedExtraCentsByDebtInRange (spendByBucketInRange, src/lib/buckets.ts).
  // Paired with the superseded-payoff adjustment below (one query each, both
  // keyed by debtId) — see confirmProjectedExtras where they meet.
  const mappedDebtPayments = await buildDebtPaymentCards(
    session.user.householdId,
    debtPayments,
    debtIdsWithPendingReview,
    utcMonthStart,
    utcMonthEnd,
  );

  // A bucket represents this calendar month — a bill / debt payment whose
  // next occurrence is a future month (a newly-tracked bill first due next
  // month, a BNPL plan whose first installment is next month) shouldn't show
  // here until its month comes around (household request, 2026-09-03). It
  // never affected the bucket's cap or pace math either way (occurrencesInPeriod
  // returns nothing for a future-month due date — see src/lib/buckets.ts), so
  // this is purely trimming the list to what's actually relevant this month.
  // Kept: anything due or paid this month, a cancelled-but-paid-this-month
  // bill (already scoped by currentPeriodBillWhere), a skipped bill (real
  // report, 2026-09-14: skipping Summit Gas here advanced its nextDueDate to
  // next month, same as any other skip — this filter didn't know about the
  // new "Skipped, Undo" state and quietly dropped the row entirely, exactly
  // the case it was never written to handle, since skipping didn't exist
  // yet on 2026-09-03), and any projected payoff extra landing this month.
  const visibleBills = mappedBills.filter((b) => {
    if (b.canceled) return true;
    if (b.skippedCycleDueDate) return true;
    if (b.lastPaidDate && b.lastPaidDate >= utcMonthStartISO && b.lastPaidDate < utcMonthEndISO) return true;
    return b.nextDueDate < utcMonthEndISO;
  });
  const visibleDebtPayments = mappedDebtPayments.filter(
    (dp) =>
      dp.extraPayments.length > 0 ||
      dp.projectedExtras.length > 0 ||
      dp.slots.length > 0 ||
      // A no-minimum card has no meaningful "due this month" — it only earns a
      // spot once a real payment or projected extra lands (both handled above).
      (!dp.ignoreMinimumPayment && dp.nextDueThisMonth),
  );

  // The spend-by-category / -by-merchant breakdown shows the household's
  // REAL total out the door, so a debt payment contributes its full paid
  // amount here (unlike the bucket total — see spendByBucketInRange —
  // which caps it). `excludedCents` records how much of a row is past the
  // per-cycle ceiling and therefore NOT in the bucket total, for the row's
  // annotation. With the payoff plan ON there is no ceiling — every dollar
  // is planned paydown and counts — so no row carries the annotation
  // (matches budgetedDebtPaymentCents, src/lib/debt-payment-budget.ts). Plan OFF: the
  // ceiling is the cycle's minimum(s); greedy oldest-first so the minimum
  // fills it and a lump-sum payoff carries the annotation on its own row.
  // Merchant key for the by-merchant breakdown + its row filter: the same
  // effective label the Singles rows display (pattern > INSTALLMENT debt >
  // the transaction's own), else the receipt-resolved party, else the
  // pending-stripped bank merchant — see spendMerchantKey.
  //
  // A transaction that satisfied a tracked bill or debt on this page is keyed
  // by that card's own name instead (household report, 2026-09-29): the raw
  // bank text is whatever the bank felt like printing — "Payment from
  // Checking" for a credit union's internal loan transfer, "Shl Payments
  // Web" for a mortgage — and never matched the card's name, so the row
  // couldn't filter anything (only a debt whose bank text happened to equal
  // its own name worked). The link to the bill/debt is already on the
  // transaction; no per-bank descriptor parsing needed.
  const billNameById = new Map(mappedBills.map((b) => [b.id, b.name]));
  const debtNameById = new Map(debtPayments.map((p) => [p.debtId, p.debt.account?.displayName ?? p.debt.name]));
  const merchantKeyOf = (t: {
    merchant: string;
    label: string | null;
    resolvedMerchant: string | null;
    billId?: string | null;
    debtId?: string | null;
    pattern?: { label: string | null } | null;
    debt?: { label: string | null; debtType: string } | null;
  }) =>
    (t.billId ? billNameById.get(t.billId) : undefined) ??
    (t.debtId ? debtNameById.get(t.debtId) : undefined) ??
    spendMerchantKey(
      t.merchant,
      t.pattern?.label ?? (t.debt?.debtType === "INSTALLMENT" ? t.debt.label : null) ?? t.label,
      t.resolvedMerchant,
    );
  const debtPaymentEntries: SpendEntry[] = [];
  const dpGroups = new Map<string, typeof debtPaymentSpend>();
  for (const t of debtPaymentSpend) {
    if (!t.debtPaymentId || !t.debtPayment) continue;
    const arr = dpGroups.get(t.debtPaymentId) ?? [];
    arr.push(t);
    dpGroups.set(t.debtPaymentId, arr);
  }
  for (const txns of dpGroups.values()) {
    const dp = txns[0].debtPayment!;
    // Same bounds getBucketsWithProgress -> spendByBucketInRange feeds its
    // own copy of this ceiling math.
    const occurrences = occurrencesInPeriod(dp.nextDueDate, dp.cadence, start, end).length;
    let remainingCeiling = payoffPlanEnabled
      ? Number.POSITIVE_INFINITY
      : dp.amountCents * Math.max(1, occurrences);
    for (const t of [...txns].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime())) {
      const net = Math.max(0, Math.abs(t.amountCents) - accountedForCents(t));
      if (net === 0) continue;
      const counted = Math.max(0, Math.min(net, remainingCeiling));
      remainingCeiling -= counted;
      debtPaymentEntries.push({
        amountCents: net,
        excludedCents: net - counted,
        categoryLabel: dp.category?.name ?? "Uncategorized",
        // The debt card's own name — see merchantKeyOf.
        merchant: dp.debt.account?.displayName ?? dp.debt.name,
      });
    }
  }

  // This bucket's real spend so far this period, for the breakdown
  // carousel's category/merchant slides — merges plain bucketId-scoped
  // transactions with the debt-payment-linked ones fetched separately above
  // (debtPaymentSpend), since the latter never carry their own categoryId
  // (only their DebtPayment.categoryId does) and never carry this bucket's
  // bucketId at all. Same accountedFor-exclusion logic as
  // getBucketsWithProgress: an already-accounted-for purchase's own amount
  // doesn't count twice.
  const spendEntries: SpendEntry[] = [
    // Charges net of their refunds (whenever posted), plus any credit with
    // no specific charge on its own date — see src/lib/spend.ts. A refund
    // tied to a charge in another month is skipped here; it already reduced
    // that month.
    ...spendEntriesFrom(
      transactions,
      (categoryId) => (categoryId ? (bucketCategories.find((c) => c.id === categoryId)?.name ?? "Uncategorized") : "Uncategorized"),
      merchantKeyOf,
    ),
    ...debtPaymentEntries.filter((e) => e.amountCents > 0 || (e.excludedCents ?? 0) > 0),
  ];

  // The category / merchant labels the spend-filter carousel can actually
  // filter by — every distinct value carried by an entry card *rendered on
  // this page*: the Singles list (only shown for non-RECURRING buckets), the
  // Recurring bills, debt payments, and DEBIT patterns. A breakdown row whose
  // label isn't in here still shows (it's real spend) but isn't a filter
  // toggle — clicking it could only ever yield an empty list, which is exactly
  // the confusing state this closes (spend attributed to a category that lives
  // in another bucket resolves to "Uncategorized" here, matching nothing).
  // BucketEntryFilterProvider also prunes any selection that drops out of
  // these on a later render.
  // On a RECURRING bucket this is now true whenever there are orphan charges
  // to show (see orphanTransactions) — otherwise there's still no list.
  const singlesShown = bucket.trackingMode !== "RECURRING" || orphanTransactions.length > 0;
  // Drives the desktop split below — a bucket's mix of Recurring vs. Singles
  // content varies a lot (an "Amazon"-style bucket is Singles only; a
  // "Mortgage"-style one is Recurring only; most are both), so the `lg:`
  // layout has to adapt rather than assume a fixed column count.
  const hasRecurring = visibleBills.length > 0 || visibleDebtPayments.length > 0 || patterns.length > 0;
  const catName = (id: string | null) => (id ? categories.find((c) => c.id === id)?.name ?? "Uncategorized" : "Uncategorized");
  const filterCategoryValues = [
    ...new Set([
      ...(singlesShown ? singlesTransactions.map((t) => catName(t.categoryId)) : []),
      ...visibleBills.map((b) => b.categoryName ?? "Uncategorized"),
      ...visibleDebtPayments.map((dp) => dp.categoryName ?? "Uncategorized"),
      ...patterns.map((p) => p.category?.name ?? "Uncategorized"),
    ]),
  ];
  const filterMerchantValues = [
    ...new Set([
      ...(singlesShown ? singlesTransactions.map(merchantKeyOf) : []),
      ...visibleBills.map((b) => b.name),
      ...visibleDebtPayments.map((dp) => dp.debtName),
    ]),
  ];
  // Labels in donut-wedge order (descending real spend) so a selected filter's
  // color matches its wedge — see BucketEntryFilterProvider.
  const spendLabelOrder = spendBreakdownLabelOrder(spendEntries);
  const breakdownCards = spendBreakdownCards(spendEntries, filterCategoryValues, filterMerchantValues);

  return (
    <AppShell
      title={bucket.name}
      titleActions={
        <BucketTitleSettings
          bucket={bucket}
          categories={bucketCategories}
          amountRoutingRules={amountRoutingRules.map((r) => ({
            id: r.id,
            merchant: r.merchant,
            amountMinCents: r.amountMinCents ?? 0,
            amountMaxCents: r.amountMaxCents ?? 0,
          }))}
          routingBuckets={reassignBuckets.map((b) => ({ id: b.id, name: b.name }))}
          isOwner={isOwner}
          alertsLocked={
            !isOwner &&
            !!(await db.user.findUnique({ where: { id: session.user.id }, select: { notificationsLocked: true } }))
              ?.notificationsLocked
          }
          currentUserId={session.user.id}
          members={householdMembers}
          alertOverrides={bucketAlertOverrides}
        />
      }
      user={session.user}
      breadcrumb={{ href: "/buckets", label: "All Buckets" }}
    >
      <BucketProgressBar progress={progress} bucket={bucket} />

      <BucketEntryFilterProvider
        categoryValues={filterCategoryValues}
        merchantValues={filterMerchantValues}
        categoryOrder={spendLabelOrder.category}
        merchantOrder={spendLabelOrder.merchant}
      >
        {/* Spend-by-category / by-merchant only — the projected "Recurring
            Total" slide was removed 2026-08-27 (household: confusing next to
            real-spend tables, and the per-bill cards below already itemise
            it). SwipeCarousel no-ops on 0 children and unwraps a single one.
            Desktop: the two donuts sit side by side (`desktopGrid`) — the only
            content on the page that wants the extra width. A lone card is
            capped so it doesn't stretch across the whole canvas. */}
        <div className={breakdownCards.length === 1 ? "lg:mx-auto lg:w-full lg:max-w-md" : undefined}>
          <SwipeCarousel desktopGrid>{breakdownCards}</SwipeCarousel>
        </div>

        <ActiveEntryFilterSummary />

        {/* Recurring vs. Singles split at `lg:`+ — side-by-side only when
            both have content (most buckets); otherwise whichever one exists
            takes the full width instead of sitting in a narrow centered
            column with empty space either side (a Recurring-only "Mortgage"
            bucket, or a Singles-only "Amazon" one, both looked cramped at a
            fixed max-w regardless of how much desktop width was actually
            available — household report, 2026-09-23). Mobile is unchanged:
            always one plain stacked column. `items-start` so one column's
            height never stretches the other's cards. */}
        <div
          className={
            hasRecurring && singlesShown
              ? "flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6"
              : "flex flex-col gap-6"
          }
        >
          {hasRecurring && (
            <div className="flex flex-col gap-6">
              <BucketBillsSection
                bills={visibleBills}
                debtPayments={visibleDebtPayments}
                patterns={patterns.map((p): PatternData => ({
                  id: p.id,
                  label: p.label,
                  direction: p.direction,
                  channelKeyword: p.channelKeyword,
                  amountMinCents: p.amountMinCents,
                  amountMaxCents: p.amountMaxCents,
                  dayOfMonthStart: p.dayOfMonthStart,
                  dayOfMonthEnd: p.dayOfMonthEnd,
                  weekdays: p.weekdays,
                  bucketId: p.bucketId,
                  bucketName: bucket.name,
                  debtId: p.debtId,
                  debtName: null,
                  countsAsIncome: p.countsAsIncome,
                  billId: null,
                  billName: null,
                  categoryId: p.categoryId,
                  categoryName: p.category?.name ?? null,
                  counterpartyName: p.counterpartyName,
                  noteKeywords: p.noteKeywords,
                  cadence: p.cadence,
                  toleranceCents: p.toleranceCents,
                  dueDateLocked: p.dueDateLocked,
                  active: p.active,
                  ...serializePatternDates(p, start, end),
                }))}
                categories={categories}
                allBuckets={allBuckets.map((b) => ({ id: b.id, name: b.name }))}
                debts={debtOptions}
                accountedForSuggestions={accountedForSuggestions}
              />
            </div>
          )}

          {singlesShown && (
            <div>
              <SinglesList
                // RECURRING only ever renders this block when there's at least
                // one orphan (see singlesShown), so it never needs the
                // "nothing here" empty state the Singles list keeps.
                title={bucket.trackingMode === "RECURRING" ? "Other Charges" : "Singles"}
                rows={singlesTransactions.map(
                  (t): SinglesRow => ({
                    id: t.id,
                    categoryId: t.categoryId,
                    merchant: merchantKeyOf(t),
                    transaction: {
                      ...t,
                      label: t.pattern?.label ?? (t.debt?.debtType === "INSTALLMENT" ? t.debt.label : null) ?? t.label,
                      hasReceipt: !!t.receipt,
                      receiptItems: (t.receiptItems as ReceiptLineItem[] | null) ?? null,
                      receiptDate: t.receipt
                        ? (t.receipt.occurredOn ?? t.receipt.receivedAt).toISOString().slice(0, 10)
                        : null,
                    },
                    labelSuggestions: labelSuggestions[t.merchant] ?? [],
                    reimbursementSuggestions: reimbursementSuggestions[t.id] ?? [],
                  }),
                )}
                buckets={reassignBuckets}
                currentBucketId={bucket.id}
                debts={debtOptions}
                categories={categories}
              />
            </div>
          )}
        </div>
      </BucketEntryFilterProvider>
    </AppShell>
  );
}
