import Link from "next/link";
import { redirect } from "next/navigation";
import { PartyPopper, EyeOff, Target, Landmark, PiggyBank, CreditCard, Wallet, Binoculars } from "lucide-react";
import { buildBnplSchedule } from "@/lib/bnpl-schedule";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/money";
import { formatDate, ordinal } from "@/lib/date";
import { hasFullAccess, canViewAccountBalance } from "@/lib/access";
import { getUntrackedLiabilityAccounts } from "@/lib/untracked-liabilities";
import { getHiddenItems } from "@/lib/hidden-items";
import {
  defaultDebtPaymentBucketId,
  getActiveInsufficientMinimumDebts,
  getActiveDebtsNeedingSetup,
  getPendingDebtAmountReviews,
  getPendingDebtBalanceReviews,
  debtSetupReason,
} from "@/lib/debt-payments";
import { AppShell } from "@/components/app-shell";
import { AddDebtForm } from "@/app/debts/add-debt-form";
import { MinPaymentWarning } from "@/app/debts/min-payment-warning";
import { NeedsSetupWarning } from "@/app/debts/needs-setup-warning";
import { DebtAmountReviewCard } from "@/components/debt-amount-review-card";
import { DebtBalanceReviewCard } from "@/components/debt-balance-review-card";
import type { PlanReceiptItem } from "@/components/plan-receipt-section";
import { ConnectForm } from "./connect-form";
import { ConnectionActions } from "./connection-actions";
import { SimpleFinErrorNotice } from "./simplefin-error-notice";
import { AccountEditor } from "./account-editor";
import { TrackAsDebtForm } from "./track-as-debt-form";
import { ManualDebtEditor } from "./manual-debt-editor";
import { AccountsUsageSynopsis } from "./accounts-usage-synopsis";
import { HideDebtButton } from "./hide-debt-button";
import { ExpandableSummary } from "./expandable-summary";
import {
  ActivityList,
  BnplScheduleList,
  DetailGrid,
  DetailSection,
  DetailTile,
  cadenceLabel,
  shortDate,
  type ActivityItem,
} from "./account-details";
import type { AccountType, SyncMode } from "@prisma/client";

const TYPE_LABEL: Record<AccountType, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit Card",
  LOAN: "Loan",
  INVESTMENT: "Investment",
  OTHER: "Other",
};

const SYNC_MODE_LABEL: Record<SyncMode, string> = {
  TRANSACTIONS: "Transactions",
  BALANCE_ONLY: "Balance Only",
};

export default async function AccountsSettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const isOwner = session.user.role === "OWNER";
  const householdId = session.user.householdId;

  const [
    connection,
    debts,
    assets,
    goals,
    untrackedLiabilities,
    buckets,
    defaultBucketId,
    categories,
    insufficientMinimumDebts,
    pendingDebtAmountReviews,
    pendingDebtBalanceReviews,
  ] = await Promise.all([
    db.bankConnection.findUnique({
      where: { householdId },
      include: { accounts: { orderBy: { name: "asc" }, include: { owner: { select: { name: true } } } } },
    }), // budgetTracked/displayName come along for free — accounts isn't a `select`
    db.debt.findMany({
      where: { householdId },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        accountId: true,
        name: true,
        debtType: true,
        kind: true,
        aprBasisPoints: true,
        minPaymentCents: true,
        ignoreMinimumPayment: true,
        termsConfirmed: true,
        balanceCents: true,
        installmentsTotal: true,
        installmentsRemaining: true,
        purchaseDate: true,
        includeInPayoffPlan: true,
        paidOffDate: true,
        hiddenAt: true,
        label: true,
        receiptItems: true,
        receiptTotalCents: true,
      },
    }),
    db.asset.findMany({
      where: { householdId, accountId: { not: null } },
      select: { accountId: true, name: true },
    }),
    db.savingsGoal.findMany({
      where: { householdId, accountId: { not: null } },
      select: { accountId: true, name: true },
    }),
    getUntrackedLiabilityAccounts(householdId),
    db.bucket.findMany({
      where: { householdId, retiredAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    defaultDebtPaymentBucketId(householdId),
    db.billCategory.findMany({
      where: { householdId },
      select: { id: true, name: true, bucketId: true },
      orderBy: { name: "asc" },
    }),
    getActiveInsufficientMinimumDebts(householdId),
    isOwner ? getPendingDebtAmountReviews(householdId) : Promise.resolve([]),
    isOwner ? getPendingDebtBalanceReviews(householdId) : Promise.resolve([]),
  ]);
  const debtsNeedingSetup = await getActiveDebtsNeedingSetup(householdId);

  const debtPayments = await db.debtPayment.findMany({
    where: { householdId, debtId: { in: debts.map((d) => d.id) }, active: true },
    select: {
      id: true,
      debtId: true,
      cadence: true,
      toleranceCents: true,
      amountDueCents: true,
      categoryId: true,
      nextDueDate: true,
      bucketId: true,
      dueDateLocked: true,
    },
  });
  const debtPaymentByDebtId = new Map(
    debtPayments.map((p) => [
      p.debtId,
      {
        id: p.id,
        cadence: p.cadence,
        toleranceCents: p.toleranceCents,
        amountDueCents: p.amountDueCents,
        categoryId: p.categoryId,
        nextDueDate: p.nextDueDate.toISOString().slice(0, 10),
        bucketId: p.bucketId,
        dueDateLocked: p.dueDateLocked,
      },
    ]),
  );

  // Same per-debt "needs setup" definition /debts uses (debtNeedsSetup,
  // src/lib/debt-payments.ts) — this page used to compute its own without
  // the pending-review check, so a debt with an open "did your minimum
  // change?" question read as fully confirmed here while /debts correctly
  // flagged it (real report, 2026-08-16).
  const pendingReviews = await db.debtAmountReview.findMany({
    where: { householdId },
    select: { debtPayment: { select: { debtId: true } } },
  });
  const debtIdsWithPendingReview = new Set(pendingReviews.map((r) => r.debtPayment.debtId));

  // Expanded-card data (2026-10-07): every payment linked to each visible
  // debt, oldest first — a BNPL plan's schedule wants all of them, a card/
  // loan just its latest few. Positive = money paid toward the debt; a synced
  // debt's own account also carries the negative mirror credit ("Payment from
  // Checking"), dropped below so a payment isn't listed twice.
  const visibleDebtIds = debts.filter((d) => !d.hiddenAt).map((d) => d.id);
  const debtAccountIdById = new Map(debts.map((d) => [d.id, d.accountId]));
  const paymentTxns = await db.transaction.findMany({
    where: { householdId, debtId: { in: visibleDebtIds }, amountCents: { gt: 0 } },
    select: { id: true, debtId: true, accountId: true, occurredOn: true, amountCents: true, merchant: true, label: true, pending: true },
    orderBy: [{ occurredOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const paymentsByDebtId = new Map<string, ActivityItem[]>();
  for (const t of paymentTxns) {
    if (t.accountId && t.accountId === debtAccountIdById.get(t.debtId!)) continue;
    const list = paymentsByDebtId.get(t.debtId!) ?? [];
    list.push({
      id: t.id,
      date: t.occurredOn.toISOString().slice(0, 10),
      label: t.label ?? t.merchant,
      amountCents: t.amountCents,
      pending: t.pending,
    });
    paymentsByDebtId.set(t.debtId!, list);
  }
  const recentPayments = (debtId: string) => (paymentsByDebtId.get(debtId) ?? []).slice(-5).reverse();

  // Latest few transactions on each connected account — charges, credits
  // and pending ones alike — for its "Recent Activity" list. A card/loan
  // shows its own account's feed too (household request, 2026-10-07: every
  // transaction, not just matched payments). One small query per account — a
  // household has a handful, and `take` per account is what keeps a busy
  // checking account from crowding out the rest.
  const activityAccounts = (connection?.accounts ?? []).filter((a) => !a.hiddenAt);
  const activityByAccountId = new Map<string, ActivityItem[]>(
    await Promise.all(
      activityAccounts.map(async (a) => {
        const txns = await db.transaction.findMany({
          where: { householdId, accountId: a.id },
          select: { id: true, occurredOn: true, amountCents: true, merchant: true, resolvedMerchant: true, label: true, pending: true },
          orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
          take: 5,
        });
        return [
          a.id,
          txns.map((t) => ({
            id: t.id,
            date: t.occurredOn.toISOString().slice(0, 10),
            label: t.label ?? t.resolvedMerchant ?? t.merchant,
            amountCents: t.amountCents,
            pending: t.pending,
          })),
        ] as const;
      }),
    ),
  );

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  type DebtRow = (typeof debts)[number];
  type TrackedPayment = NonNullable<ReturnType<typeof debtPaymentByDebtId.get>>;

  // The debt half of an expanded card — shared by synced cards/loans and
  // manual ones (BNPL gets its own layout below).
  const debtTermsTiles = (d: DebtRow, dp: TrackedPayment | null) => {
    const isPaidOff = d.balanceCents === 0;
    return (
      <DetailGrid>
        <DetailTile label="APR" value={`${(d.aprBasisPoints / 100).toFixed(2)}%`} />
        <DetailTile
          label="Minimum"
          value={d.ignoreMinimumPayment ? "No Minimum" : `${formatCents(d.minPaymentCents)}/mo`}
          tone={d.ignoreMinimumPayment ? "muted" : "default"}
        />
        {dp && !isPaidOff && (
          <DetailTile
            label="Amount Due"
            value={formatCents(dp.amountDueCents)}
            tone={dp.amountDueCents > 0 ? "bad" : "good"}
          />
        )}
        <DetailTile
          label="Next Due"
          value={dp?.nextDueDate && !isPaidOff ? `${dp.dueDateLocked ? "" : "~"}${shortDate(dp.nextDueDate)}` : "—"}
          tone={dp?.nextDueDate && !isPaidOff ? (dp.dueDateLocked ? "default" : "warn") : "muted"}
        />
        <DetailTile label="Cadence" value={cadenceLabel(dp?.cadence)} />
        <DetailTile
          label="Payoff Plan"
          value={d.includeInPayoffPlan ? "Included" : "Not Included"}
          tone={d.includeInPayoffPlan ? "good" : "muted"}
        />
        <DetailTile label="Bucket" value={(dp?.bucketId && bucketNameById.get(dp.bucketId)) || "None"} tone={dp?.bucketId ? "default" : "muted"} />
        <DetailTile
          label="Category"
          value={(dp?.categoryId && categoryNameById.get(dp.categoryId)) || "None"}
          tone={dp?.categoryId ? "default" : "muted"}
        />
        {d.paidOffDate && <DetailTile label="Paid Off" value={shortDate(d.paidOffDate.toISOString())} tone="good" />}
        {d.label && <DetailTile label="Label" value={d.label} />}
      </DetailGrid>
    );
  };

  // A manual debt has no account feed of its own — its activity is the
  // payments matched to it.
  const recentPaymentsSection = (debtId: string) => (
    <DetailSection title="Recent Activity">
      <ActivityList items={recentPayments(debtId)} empty="No Payments Matched Yet." />
    </DetailSection>
  );

  // A BNPL plan's expanded card: plan facts, then every installment.
  const bnplDetails = (d: DebtRow, dp: TrackedPayment | null) => {
    const schedule = buildBnplSchedule({
      installmentsTotal: d.installmentsTotal,
      installmentsRemaining: d.installmentsRemaining,
      paymentCents: d.minPaymentCents,
      balanceCents: d.balanceCents,
      nextDueDate: dp?.nextDueDate ?? null,
      cadence: dp?.cadence ?? "BIWEEKLY",
      paidPayments: (paymentsByDebtId.get(d.id) ?? []).map((p) => ({ date: p.date, amountCents: p.amountCents })),
    });
    const paidCents = schedule.filter((r) => r.status === "PAID").reduce((sum, r) => sum + r.amountCents, 0);
    const paidCount = schedule.filter((r) => r.status === "PAID").length;
    const originalCents = d.receiptTotalCents ?? (d.installmentsTotal ? d.minPaymentCents * d.installmentsTotal : null);
    return (
      <>
        <DetailGrid>
          <DetailTile label="Purchased" value={d.purchaseDate ? shortDate(d.purchaseDate.toISOString()) : "—"} tone={d.purchaseDate ? "default" : "muted"} />
          <DetailTile label="Original Amount" value={originalCents != null ? formatCents(originalCents) : "—"} />
          <DetailTile label="Payment" value={formatCents(d.minPaymentCents)} />
          <DetailTile label="Cadence" value={cadenceLabel(dp?.cadence)} />
          <DetailTile label="Paid So Far" value={formatCents(paidCents)} tone="good" />
          <DetailTile label="Remaining" value={formatCents(d.balanceCents)} tone={d.balanceCents > 0 ? "bad" : "good"} />
          <DetailTile label="APR" value={`${(d.aprBasisPoints / 100).toFixed(2)}%`} />
          <DetailTile
            label="Payoff Plan"
            value={d.includeInPayoffPlan ? "Included" : "Not Included"}
            tone={d.includeInPayoffPlan ? "good" : "muted"}
          />
          <DetailTile label="Bucket" value={(dp?.bucketId && bucketNameById.get(dp.bucketId)) || "None"} tone={dp?.bucketId ? "default" : "muted"} />
          <DetailTile
            label="Category"
            value={(dp?.categoryId && categoryNameById.get(dp.categoryId)) || "None"}
            tone={dp?.categoryId ? "default" : "muted"}
          />
          {d.paidOffDate && <DetailTile label="Paid Off" value={shortDate(d.paidOffDate.toISOString())} tone="good" />}
          {d.label && <DetailTile label="Label" value={d.label} />}
        </DetailGrid>
        <DetailSection
          title="Payment Schedule"
          aside={d.installmentsTotal ? `${paidCount} of ${d.installmentsTotal} Paid` : undefined}
        >
          {schedule.length > 0 ? (
            <BnplScheduleList rows={schedule} />
          ) : (
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              Set the payment count and first payment date (pencil above) to see the schedule.
            </p>
          )}
          {schedule.length > 0 && d.balanceCents > 0 && !dp?.nextDueDate && (
            <p className="text-xs text-gray-500 dark:text-neutral-400">Set the first payment date to project upcoming payments.</p>
          )}
        </DetailSection>
      </>
    );
  };

  const manualDebtDetails = (d: DebtRow) => {
    const dp = debtPaymentByDebtId.get(d.id) ?? null;
    if (d.debtType === "INSTALLMENT") return bnplDetails(d, dp);
    return (
      <>
        <DetailSection title="Terms">{debtTermsTiles(d, dp)}</DetailSection>
        {recentPaymentsSection(d.id)}
      </>
    );
  };

  // What each synced account actually feeds — the whole point of this
  // section is answering "is this connected account doing anything yet?"
  // at a glance, since a card/loan/investment account can sit fully synced
  // with a real balance for a while before anyone tracks it as a Debt/
  // Asset. Checking/savings accounts are always feeding the bucket
  // transaction pipeline the moment they're connected — nothing to
  // separately "track" there — but they DO have their own on/off switch for
  // net worth specifically (Account.excludedFromNetWorth, flipped from
  // /networth's Cash section), so they get a status line below too, just
  // driven by that flag instead of this lookup map.
  const linkedDebts = debts.filter((d) => d.accountId !== null);
  const manualDebts = debts.filter((d) => d.accountId === null && !d.hiddenAt);
  // BNPL is always debtType INSTALLMENT (forced server-side in createDebt);
  // CARD/LOAN are both debtType REVOLVING, split by Debt.kind — see
  // DebtKind's doc comment in schema.prisma.
  // Highest balance first, paid-off (0) debts sink to the bottom — same
  // ordering the Connected Accounts "Debt" subsection uses above.
  const byBalance = (a: (typeof manualDebts)[number], b: (typeof manualDebts)[number]) => b.balanceCents - a.balanceCents;
  const bnplDebts = manualDebts.filter((d) => d.debtType === "INSTALLMENT").sort(byBalance);
  const manualCards = manualDebts.filter((d) => d.debtType === "REVOLVING" && d.kind === "CARD").sort(byBalance);
  const manualLoans = manualDebts.filter((d) => d.debtType === "REVOLVING" && d.kind === "LOAN").sort(byBalance);
  // Count only — the manage UI (restore / delete) lives on its own page at
  // /settings/hidden now; this page just links to it when there's anything
  // there. getHiddenItems covers the same set: every Debt with hiddenAt set
  // (a manual debt, or one still linked to a live Account), plus every
  // Account with hiddenAt set (only ever set by an actual removal from the
  // SimpleFIN feed — there's no manual "hide this account").
  const hiddenCount = isOwner ? (await getHiddenItems(householdId)).length : 0;
  const debtByAccountId = new Map(linkedDebts.map((d) => [d.accountId!, d]));
  // Every CREDIT_CARD/LOAN synced account, offered as a candidate to every
  // debt's "Linked Account" control (account-editor.tsx: an already-synced
  // debt re-pointing itself; manual-debt-editor.tsx: a manual debt
  // converting to synced) — including one already claimed by some *other*
  // debt, tagged via `linkedElsewhere` so the picker can warn before
  // stealing it. Real report, 2026-09-14: Sam's Club switched how it
  // connects (now via Synchrony) — SimpleFIN synced it as a brand new
  // Account/Debt pair with none of the original debt's history
  // (bucket/category/cadence tracker), while the *old* Account/Debt is
  // still technically live (just increasingly stale) rather than cleanly
  // replaced. Excluding claimed accounts entirely (the original 2026-09-11
  // design) left no way to reunite the household's real, already-configured
  // debt with its new account short of a database query — linkDebtAccount
  // itself now auto-unlinks whichever debt loses the account (see its own
  // comment), so stealing is safe as long as the UI warns first.
  const linkedAccountIds = new Set(linkedDebts.map((d) => d.accountId!));
  const debtAccountCandidates: { id: string; name: string }[] = connection
    ? connection.accounts
        .filter((a) => a.accountType === "CREDIT_CARD" || a.accountType === "LOAN")
        .map((a) => ({ id: a.id, name: a.displayName ?? a.name }))
    : [];
  const linkableAccountsByDebtId = new Map<string, { id: string; name: string; linkedElsewhere: boolean }[]>();
  for (const d of linkedDebts) {
    linkableAccountsByDebtId.set(
      d.id,
      debtAccountCandidates.map((a) => ({ ...a, linkedElsewhere: a.id !== d.accountId && linkedAccountIds.has(a.id) })),
    );
  }
  // Same candidate list, from a manual debt's perspective — it has no
  // accountId of its own, so every claimed account counts as "elsewhere".
  const linkableAccountsForManualDebt = debtAccountCandidates.map((a) => ({ ...a, linkedElsewhere: linkedAccountIds.has(a.id) }));
  const assetByAccountId = new Map(assets.map((a) => [a.accountId!, a]));
  const goalByAccountId = new Map(goals.map((g) => [g.accountId!, g]));
  const untrackedByAccountId = new Map(untrackedLiabilities.map((a) => [a.id, a]));
  const CASH_TYPES: AccountType[] = ["CHECKING", "SAVINGS"];
  const showApy = (t: AccountType) => t !== "CREDIT_CARD" && t !== "LOAN";
  // One entry per line (see simplefin-sync.ts) — a per-institution auth
  // problem doesn't flip the whole connection to status ERROR, so this list
  // is the real source of truth for "something needs re-authorizing." Each
  // entry disappears on its own the next time a sync reports no error for
  // it, i.e. once it's fixed and re-verified — nothing to dismiss by hand.
  const connectionErrors = connection?.lastError ? connection.lastError.split("\n").filter(Boolean) : [];

  return (
    <AppShell
      title="Accounts"
      user={session.user}
      breadcrumb={{ href: "/settings", label: "Settings" }}
      titleActions={
        isOwner ? <AddDebtForm buckets={buckets} defaultBucketId={defaultBucketId} categories={categories} /> : undefined
      }
    >
      {/* Desktop: connection health (synopsis, sync status, review/warning
          cards) in a sticky left rail; the account lists on the right stay a
          single column because every AccountEditor / ManualDebtEditor opens
          its edit form inline. Mobile: rail stacks first, unchanged order. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div className="flex flex-col gap-4 lg:sticky lg:top-4">
      <AccountsUsageSynopsis />

      {/* Same card /debts shows (min-payment-warning.tsx) — an insufficient
          minimum is what lights up this page's own Settings-row dot
          (app-shell.tsx/settings/page.tsx), but neither the connected- nor
          manual-debt rows below say so on their own (debtNeedsSetup doesn't
          check for it), so without this the dot pointed here with nothing
          to actually show for it (real report, 2026-08-19). */}
      {isOwner && <DebtAmountReviewCard reviews={pendingDebtAmountReviews} />}
      {isOwner && <DebtBalanceReviewCard reviews={pendingDebtBalanceReviews} />}

      <NeedsSetupWarning debts={debtsNeedingSetup} />

      <MinPaymentWarning debts={insufficientMinimumDebts} />

      {connection && isOwner && (
        <div className="rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">SimpleFIN</h3>
              {connection.status === "ACTIVE" ? (
                <span
                  role="img"
                  aria-label="Connected"
                  title="Connected"
                  className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_var(--color-emerald-500)]"
                />
              ) : (
                <span className="text-xs font-medium text-red-600 dark:text-red-400">Error</span>
              )}
            </div>
            <ConnectionActions />
          </div>
          <p className="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
            Last synced{" "}
            {connection.lastSyncedAt
              ? connection.lastSyncedAt.toLocaleString("en-US", {
                  month: "short",
                  day: "2-digit",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "never"}
          </p>
          {connectionErrors.length > 0 && (
            <ul className="mt-3 flex flex-col gap-2">
              {connectionErrors.map((message, i) => (
                <SimpleFinErrorNotice key={i} raw={message} />
              ))}
            </ul>
          )}
        </div>
      )}
      </div>

      <div className="flex flex-col gap-6">
      {!connection ? (
        isOwner ? (
          <ConnectForm />
        ) : (
          <p className="text-sm text-gray-500 dark:text-neutral-400">Not connected yet.</p>
        )
      ) : (
        <>
          <div>
            {(() => {
              // Excludes a row for either of two independent reasons: the
              // account itself is hidden (a.hiddenAt — actually gone, see
              // Account.hiddenAt in schema.prisma), or just its linked debt
              // is (hideDebt — "remove this once it's paid off," self-heals
              // back into view the moment a new charge lands, see
              // unhideDebtPaymentIfBalanceReturned in src/lib/debt-payments.ts,
              // same as manualDebts above). A hidden debt hiding the whole
              // row (not just its own debt-shaped bits) is deliberate, same
              // convention as always here — but note it never implies the
              // account is inactive: it stays fully live/synced/budget-
              // tracked, and is never purge-eligible on that basis alone.
              const visibleAccounts = connection.accounts.filter(
                (a) => !a.hiddenAt && !debtByAccountId.get(a.id)?.hiddenAt,
              );

              // Debt/Assets grouping mirrors the manual-debt sections below
              // (BNPL/Manual Card/Manual Loan) — a household wants to scan
              // "what do I owe" separate from "what do I have", not one flat
              // list ordered by account name. Debt sorts first (biggest
              // balance on top) since that's what usually needs attention;
              // each group internally sorts by |balance| descending. CHECKING/
              // SAVINGS/INVESTMENT are the only asset-shaped account types,
              // CREDIT_CARD/LOAN the only debt-shaped ones — OTHER falls into
              // its own small leftover group instead of silently vanishing.
              const rows = visibleAccounts;
              const byAbsBalance = (x: (typeof rows)[number], y: (typeof rows)[number]) =>
                Math.abs(y.balanceCents) - Math.abs(x.balanceCents);
              const debtRows = rows
                .filter((a) => a.accountType === "CREDIT_CARD" || a.accountType === "LOAN")
                .sort(byAbsBalance);
              const assetRows = rows.filter((a) => CASH_TYPES.includes(a.accountType) || a.accountType === "INVESTMENT").sort(byAbsBalance);
              const otherRows = rows.filter((a) => a.accountType === "OTHER").sort(byAbsBalance);

              const renderAccountRow = (a: (typeof rows)[number]) => {
                        const displayName = a.displayName ?? a.name;
                        const debt = debtByAccountId.get(a.id);
                  const debtPayment = debt ? (debtPaymentByDebtId.get(debt.id) ?? null) : null;
                  const asset = assetByAccountId.get(a.id);
                  const goal = goalByAccountId.get(a.id);
                  const untracked = untrackedByAccountId.get(a.id);
                  const showBalance = canViewAccountBalance(session.user, a.accountType);
                  // First failing check, in the same priority order
                  // debtNeedsSetup checks them in, so the message always
                  // matches whichever condition actually made needsSetup true.
                  // dueDateLocked true (checked below) guarantees nextDueDate
                  // is set — see upsertDebtPayment.
                  const dueDay = debtPayment?.nextDueDate ? new Date(debtPayment.nextDueDate).getUTCDate() : null;
                  const setupReason = debt
                    ? debtSetupReason(debt, debtPayment?.dueDateLocked ?? null, debtIdsWithPendingReview.has(debt.id))
                    : null;
                  const debtLabel = !debt
                    ? null
                    : setupReason
                      ? `Needs Setup — ${setupReason}`
                      : `${(debt.aprBasisPoints / 100).toFixed(2)}% APR · ${
                          debt.ignoreMinimumPayment ? "No Minimum" : `${formatCents(debt.minPaymentCents)}/mo`
                        } · Due on the ${ordinal(dueDay!)}`;
                  const debtNeedsSetupNow = Boolean(setupReason);
                  const paidOff = Boolean(debt) && a.balanceCents === 0;
                  // Classification badges — small icons up by the pencil
                  // instead of their own pill/text lines (2026-08-17), same
                  // colors as before. Only one of these three fires per row
                  // (cash/investment/debt are mutually exclusive account-type
                  // branches); "Not counted"/"Not tracked"/"Needs setup" stay
                  // as their own text lines below since they carry an
                  // actionable link or extra info a single icon can't.
                  const isCashAsset = CASH_TYPES.includes(a.accountType) && !a.excludedFromNetWorth;
                  const isInvestmentAsset = a.accountType === "INVESTMENT" && Boolean(asset);
                  const isInvestmentGoal = a.accountType === "INVESTMENT" && !asset && Boolean(goal);
                  // Stays true once a debt is paid off — a $0 card/loan is
                  // still tracked as a Debt, still (usually) budget-tracked,
                  // and still carries its includeInPayoffPlan choice (its
                  // freed minimum keeps rolling into the plan). The row should
                  // keep showing all three icons, not drop them the moment the
                  // balance hits zero (household report, 2026-08-28).
                  const isTrackedDebt =
                    (a.accountType === "CREDIT_CARD" || a.accountType === "LOAN") && Boolean(debt);
                  return (
                    <li
                      key={a.id}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        paidOff
                          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20"
                          : "border-blue-100 dark:border-neutral-800"
                      }`}
                    >
                      {/* Title/icon bar gets the full card width on its own
                          row — sharing a row with the balance squeezed a
                          long institution name's wrap point (real report,
                          2026-08-17). */}
                      <div className="flex flex-wrap items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
                        {isOwner ? (
                          <AccountEditor
                            accountId={a.id}
                            displayName={displayName}
                            budgetTracked={a.budgetTracked}
                            accountType={a.accountType}
                            apyBasisPoints={a.apyBasisPoints}
                            debt={
                              debt
                                ? {
                                    debtId: debt.id,
                                    // Always CARD/LOAN here — a linked debt's
                                    // account is always CREDIT_CARD/LOAN
                                    // (isTrackedDebt), never the BNPL path.
                                    kind: debt.kind as "CARD" | "LOAN",
                                    aprBasisPoints: debt.aprBasisPoints,
                                    minPaymentCents: debt.minPaymentCents,
                                    ignoreMinimumPayment: debt.ignoreMinimumPayment,
                                    cadence: debtPayment?.cadence ?? "MONTHLY",
                                    toleranceCents: debtPayment?.toleranceCents ?? null,
                                    categoryId: debtPayment?.categoryId ?? null,
                                    bucketId: debtPayment?.bucketId ?? null,
                                    nextDueDate: debtPayment?.nextDueDate ?? null,
                                    includeInPayoffPlan: debt.includeInPayoffPlan,
                                    linkableAccounts: linkableAccountsByDebtId.get(debt.id) ?? [],
                                  }
                                : null
                            }
                            buckets={buckets}
                            categories={categories}
                            badges={
                              <>
                                {(isCashAsset || isInvestmentAsset) && (
                                  <span
                                    role="img"
                                    aria-label="Counted as an Asset"
                                    title="Counted as an Asset"
                                    className="text-emerald-700 dark:text-emerald-400"
                                  >
                                    <Landmark size={12} />
                                  </span>
                                )}
                                {isInvestmentGoal && (
                                  <span
                                    role="img"
                                    aria-label="Tracked Toward a Savings Goal"
                                    title="Tracked Toward a Savings Goal"
                                    className="text-blue-800 dark:text-blue-400"
                                  >
                                    <PiggyBank size={12} />
                                  </span>
                                )}
                                {isTrackedDebt && (
                                  <span
                                    role="img"
                                    aria-label="Tracked as a Debt"
                                    title="Tracked as a Debt"
                                    className="text-red-700 dark:text-red-400"
                                  >
                                    <CreditCard size={12} />
                                  </span>
                                )}
                                {isTrackedDebt && debt?.includeInPayoffPlan && (
                                  <span
                                    role="img"
                                    aria-label="Included in the Debt Payoff Plan"
                                    title="Included in the Debt Payoff Plan"
                                    className="text-emerald-600 dark:text-emerald-400"
                                  >
                                    <Target size={12} />
                                  </span>
                                )}
                                {isTrackedDebt && paidOff && (
                                  <span
                                    role="img"
                                    aria-label="Watching for a New Balance"
                                    title="Watching for a New Balance"
                                    className="text-blue-700 dark:text-blue-400"
                                  >
                                    <Binoculars size={12} />
                                  </span>
                                )}
                                {a.budgetTracked && (
                                  <span
                                    role="img"
                                    aria-label="Used for Transactions"
                                    title="Used for Transactions"
                                    className="text-emerald-700 dark:text-emerald-400"
                                  >
                                    <Wallet size={12} />
                                  </span>
                                )}
                              </>
                            }
                          />
                        ) : (
                          <>
                            <span className="truncate">{displayName}</span>
                            {(isCashAsset || isInvestmentAsset) && (
                              <span
                                role="img"
                                aria-label="Counted as an Asset"
                                title="Counted as an Asset"
                                className="text-emerald-700 dark:text-emerald-400"
                              >
                                <Landmark size={12} />
                              </span>
                            )}
                            {isInvestmentGoal && (
                              <span
                                role="img"
                                aria-label="Tracked Toward a Savings Goal"
                                title="Tracked Toward a Savings Goal"
                                className="text-blue-800 dark:text-blue-400"
                              >
                                <PiggyBank size={12} />
                              </span>
                            )}
                            {isTrackedDebt && (
                              <span
                                role="img"
                                aria-label="Tracked as a Debt"
                                title="Tracked as a Debt"
                                className="text-red-700 dark:text-red-400"
                              >
                                <CreditCard size={12} />
                              </span>
                            )}
                            {isTrackedDebt && debt?.includeInPayoffPlan && (
                              <span
                                role="img"
                                aria-label="Included in the Debt Payoff Plan"
                                title="Included in the Debt Payoff Plan"
                                className="text-emerald-600 dark:text-emerald-400"
                              >
                                <Target size={12} />
                              </span>
                            )}
                            {isTrackedDebt && paidOff && (
                              <span
                                role="img"
                                aria-label="Watching for a New Balance"
                                title="Watching for a New Balance"
                                className="text-blue-700 dark:text-blue-400"
                              >
                                <Binoculars size={12} />
                              </span>
                            )}
                            {a.budgetTracked && (
                              <span
                                role="img"
                                aria-label="Used for Transactions"
                                title="Used for Transactions"
                                className="text-emerald-700 dark:text-emerald-400"
                              >
                                <Wallet size={12} />
                              </span>
                            )}
                          </>
                        )}
                        {debt && paidOff && isOwner && (
                          // Hides just this debt's card, not the whole
                          // account — there's no separate "hide the account"
                          // action; a synced account can only ever disappear
                          // from this list by actually being removed from
                          // SimpleFIN (see hideAccountsWithLinkedDebts,
                          // src/lib/simplefin-sync.ts), never by a manual
                          // click while it's still owed on. Confirm()-gated —
                          // see HideDebtButton's own comment.
                          <HideDebtButton debtId={debt.id} debtName={displayName} />
                        )}
                      </div>
                      <ExpandableSummary
                        storageKey={a.id}
                        summary={
                          <>
                            <span className="block text-xs text-gray-500 dark:text-neutral-400">
                              {a.orgName ? `${a.orgName} · ` : ""}
                              {TYPE_LABEL[a.accountType]} · {SYNC_MODE_LABEL[a.syncMode]}
                            </span>
                            {(a.accountType === "CREDIT_CARD" || a.accountType === "LOAN") &&
                              (debt && paidOff ? (
                                <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                  <PartyPopper size={13} /> Paid Off
                                  {debt.paidOffDate &&
                                    ` ${formatDate(debt.paidOffDate, { month: "short", day: "numeric", year: "numeric" })}`}
                                </span>
                              ) : debt ? (
                                <span
                                  className={`mt-0.5 block text-xs ${debtNeedsSetupNow ? "text-amber-700 dark:text-amber-400" : "text-gray-500 dark:text-neutral-400"}`}
                                >
                                  {debtLabel}
                                </span>
                              ) : (
                                <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-400">Not Tracked</span>
                              ))}
                          </>
                        }
                        balance={
                          <span
                            className={`font-medium ${
                              !showBalance
                                ? "text-neutral-900 dark:text-neutral-100"
                                : a.balanceCents >= 0
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-red-600 dark:text-red-400"
                            }`}
                          >
                            {showBalance ? formatCents(a.balanceCents) : "••••"}
                          </span>
                        }
                        footer={
                          <>
                            {CASH_TYPES.includes(a.accountType) && a.excludedFromNetWorth && (
                              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                                Not Counted —{" "}
                                <Link href="/networth" className="underline">
                                  Add It
                                </Link>
                              </p>
                            )}
                            {a.accountType === "INVESTMENT" && !asset && !goal && (
                              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">
                                Not Tracked —{" "}
                                <Link href="/networth" className="underline">
                                  Add It
                                </Link>
                              </p>
                            )}
                            {(a.accountType === "CREDIT_CARD" || a.accountType === "LOAN") && !debt && isOwner && untracked && (
                              <TrackAsDebtForm
                                accountId={a.id}
                                balanceCents={a.balanceCents}
                                knownMinPaymentCents={untracked.knownMinPaymentCents}
                              />
                            )}
                          </>
                        }
                      >
                        <DetailSection title="Account">
                          <DetailGrid>
                            <DetailTile label="Institution" value={a.orgName ?? "—"} tone={a.orgName ? "default" : "muted"} />
                            <DetailTile label="Type" value={TYPE_LABEL[a.accountType]} />
                            <DetailTile label="Sync Mode" value={SYNC_MODE_LABEL[a.syncMode]} />
                            <DetailTile
                              label="Last Synced"
                              value={
                                a.lastSyncedAt
                                  ? a.lastSyncedAt.toLocaleString("en-US", { month: "short", day: "2-digit", hour: "numeric", minute: "2-digit" })
                                  : "Never"
                              }
                              tone={a.lastSyncedAt ? "default" : "muted"}
                            />
                            <DetailTile
                              label="Transactions"
                              value={a.budgetTracked ? "Used" : "Not Used"}
                              tone={a.budgetTracked ? "good" : "muted"}
                            />
                            <DetailTile
                              label="Net Worth"
                              value={
                                CASH_TYPES.includes(a.accountType)
                                  ? a.excludedFromNetWorth
                                    ? "Not Counted"
                                    : "Counted"
                                  : a.accountType === "INVESTMENT"
                                    ? asset
                                      ? `Asset · ${asset.name}`
                                      : goal
                                        ? `Goal · ${goal.name}`
                                        : "Not Tracked"
                                    : a.accountType === "CREDIT_CARD" || a.accountType === "LOAN"
                                      ? debt
                                        ? "Counted as Debt"
                                        : "Not Tracked"
                                      : "—"
                              }
                              tone={
                                isCashAsset || isInvestmentAsset || isInvestmentGoal || isTrackedDebt
                                  ? "good"
                                  : a.accountType === "OTHER"
                                    ? "muted"
                                    : "warn"
                              }
                            />
                            {showApy(a.accountType) && (
                              <DetailTile
                                label="APY"
                                value={a.apyBasisPoints != null ? `${(a.apyBasisPoints / 100).toFixed(2)}%` : "—"}
                                tone={a.apyBasisPoints != null ? "good" : "muted"}
                              />
                            )}
                            {a.owner?.name && <DetailTile label="Owner" value={a.owner.name} />}
                            {a.displayName && a.displayName !== a.name && <DetailTile label="Bank Name" value={a.name} wide />}
                          </DetailGrid>
                        </DetailSection>
                        {debt && (
                          <>
                            <DetailSection title="Debt Terms">{debtTermsTiles(debt, debtPayment)}</DetailSection>
                          </>
                        )}
                        {showBalance && (
                          <DetailSection title="Recent Activity">
                            <ActivityList items={activityByAccountId.get(a.id) ?? []} empty="No Transactions Yet." signFlip />
                          </DetailSection>
                        )}
                      </ExpandableSummary>
                    </li>
                );
              };

              return (
                <>
                  <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    Connected Accounts ({rows.length})
                  </h2>
                  {rows.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-neutral-400">
                      No accounts synced yet{isOwner ? ' — try "Sync Now" above.' : "."}
                    </p>
                  ) : (
                    <>
                      {debtRows.length > 0 && (
                        <div className="mb-3">
                          <h3 className="mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Debt</h3>
                          <ul className="flex flex-col gap-2">{debtRows.map(renderAccountRow)}</ul>
                        </div>
                      )}
                      {assetRows.length > 0 && (
                        <div className="mb-3">
                          <h3 className="mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Assets</h3>
                          <ul className="flex flex-col gap-2">{assetRows.map(renderAccountRow)}</ul>
                        </div>
                      )}
                      {otherRows.length > 0 && (
                        <div className="mb-3">
                          <h3 className="mb-1.5 text-xs font-semibold text-neutral-500 dark:text-neutral-400">Other</h3>
                          <ul className="flex flex-col gap-2">{otherRows.map(renderAccountRow)}</ul>
                        </div>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </>
      )}

      {isOwner &&
        [
          { label: "BNPL", items: bnplDebts },
          { label: "Manual Card", items: manualCards },
          { label: "Manual Loan", items: manualLoans },
        ].map(
          ({ label, items }) =>
            items.length > 0 && (
              <div key={label}>
                <h2 className="mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                  {label} ({items.length})
                </h2>
                <ul className="flex flex-col gap-2">
                  {items.map((d) => (
                    <ManualDebtEditor
                      key={d.id}
                      debt={{
                        ...d,
                        purchaseDate: d.purchaseDate ? d.purchaseDate.toISOString().slice(0, 10) : null,
                        paidOffDate: d.paidOffDate ? d.paidOffDate.toISOString().slice(0, 10) : null,
                        receiptItems: (d.receiptItems as PlanReceiptItem[] | null) ?? null,
                      }}
                      nextDueDate={debtPaymentByDebtId.get(d.id)?.nextDueDate ?? null}
                      dueDateLocked={debtPaymentByDebtId.get(d.id)?.dueDateLocked ?? false}
                      cadence={debtPaymentByDebtId.get(d.id)?.cadence ?? null}
                      toleranceCents={debtPaymentByDebtId.get(d.id)?.toleranceCents ?? null}
                      bucketId={debtPaymentByDebtId.get(d.id)?.bucketId ?? null}
                      buckets={buckets}
                      defaultBucketId={defaultBucketId}
                      categoryId={debtPaymentByDebtId.get(d.id)?.categoryId ?? null}
                      categories={categories}
                      linkableAccounts={linkableAccountsForManualDebt}
                      details={manualDebtDetails(d)}
                    />
                  ))}
                </ul>
              </div>
            ),
        )}

      {isOwner && hiddenCount > 0 && (
        <Link
          href="/settings/hidden"
          className="flex items-center justify-between rounded-xl border border-neutral-200 dark:border-neutral-800 p-4"
        >
          <span>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Hidden Accounts &amp; Debts
            </p>
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {hiddenCount} {hiddenCount === 1 ? "item" : "items"} hidden — restore or permanently delete
            </p>
          </span>
          <EyeOff size={18} className="shrink-0 text-gray-400 dark:text-neutral-500" />
        </Link>
      )}
      </div>
      </div>
    </AppShell>
  );
}
