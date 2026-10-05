import Link from "next/link";
import { PAYMENT_RECEIPT_SELECT } from "@/lib/payment-receipt";
import { redirect } from "next/navigation";
import { Receipt } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { getIncomeSummary, getIncomeThisMonth, getAdHocIncomeThisMonth } from "@/lib/income";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { detectRecurringIncome } from "@/lib/income-detect";
import { hasFullAccess } from "@/lib/access";
import { formatCents } from "@/lib/money";
import { AppShell } from "@/components/app-shell";
import { StatCard } from "@/components/stat-card";
import { getActiveUnlabeledP2PTransfers } from "@/lib/p2p-transfers";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { PatternRow } from "@/components/pattern-row";
import { serializePatternDates } from "@/lib/pattern-data";
import { currentPeriodPatternWhere } from "@/lib/pattern-match";
import { CountWarning } from "@/components/count-warning";
import { IncomeRow } from "./income-row";
import { expectedStatus } from "@/lib/date";
import { IncomeSuggestions } from "./income-suggestions";
import { ExpectedIncomeThisMonth } from "./expected-income-this-month";
import { AdHocIncomeCard } from "./ad-hoc-income-card";
import { dismissUnlabeledP2PCredits } from "./actions";

export default async function IncomePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const householdId = session.user.householdId;
  // UTC-bounded current calendar month — see utcPeriodBounds's own doc
  // comment (Transaction.occurredOn/RecurringPattern.nextDueDate are both
  // UTC-midnight @db.Date values). Feeds serializePatternDates' own
  // cyclePaymentStatus computation below.
  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const [
    { incomes, totalMonthlyCents, isEstimated: incomeIsEstimated, method, includeP2PInIncomeCalc },
    expected,
    detected,
    unlabeledP2PCredits,
    adHocIncome,
    incomePatterns,
    reimbursementPatterns,
    buckets,
    debts,
    bills,
    categories,
  ] = await Promise.all([
    getIncomeSummary(householdId),
    getIncomeThisMonth(householdId),
    detectRecurringIncome(householdId),
    getActiveUnlabeledP2PTransfers(householdId, "CREDIT"),
    getAdHocIncomeThisMonth(householdId),
    // CREDIT patterns the household has explicitly marked as real income
    // (not a reimbursement) — the P2P counterpart to the tracked Income
    // list below, same as a bucket-targeted DEBIT pattern shows on that
    // bucket's own page (src/app/buckets/[id]/page.tsx).
    db.recurringPattern.findMany({
      where: { householdId, direction: "CREDIT", countsAsIncome: true, ...currentPeriodPatternWhere() },
      include: {
        category: { select: { name: true } },
        transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, ...PAYMENT_RECEIPT_SELECT } },
      },
      orderBy: { createdAt: "asc" },
    }),
    // CREDIT patterns pinned to a bill (countsAsIncome:false, billId set —
    // "mom repays the Verizon bill") — money in, just not counted as
    // income. Previously only ever visible on the bill's own card (see
    // BillRow/bucket-bills-section.tsx); listed here too (2026-08-23,
    // household request) so Income is a complete "everything money-in"
    // picture, not just the portion that counts toward the total above.
    db.recurringPattern.findMany({
      where: { householdId, direction: "CREDIT", countsAsIncome: false, billId: { not: null }, ...currentPeriodPatternWhere() },
      include: {
        // category itself deliberately NOT included here — a reimbursement
        // pinned to a bill never carries its own; the bill's own category
        // (selected below) is what shows wherever this pattern's categoryName
        // is used (household feedback, 2026-09-11).
        bill: { select: { name: true, category: { select: { name: true } } } },
        transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, ...PAYMENT_RECEIPT_SELECT } },
      },
      orderBy: { label: "asc" },
    }),
    db.bucket.findMany({ where: { householdId, retiredAt: null }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
    // Hidden debts / paid-off loans stay out of the PatternPanel debt picker — see pickableDebtWhere.
    db.debt.findMany({ where: { householdId, ...pickableDebtWhere() }, select: { id: true, name: true }, orderBy: { sortOrder: "asc" } }),
    db.recurringBill.findMany({
      where: { householdId, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.billCategory.findMany({ where: { householdId }, select: { id: true, name: true, bucketId: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <AppShell
      title="Income"
      user={session.user}
      titleActions={
        <Link
          href="/transactions?status=moneyIn"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-blue-50 dark:bg-blue-950/40 px-3 text-xs font-medium text-blue-800 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/60"
        >
          <Receipt size={14} />
          Transactions
        </Link>
      }
    >
      {/* Desktop: a summary rail (totals, what's expected, nudges) beside the
          editable lists — which stay a single column because IncomeRow /
          PatternRow open their edit form inline. Mobile: the rail's cards
          stack first (unchanged order), then the lists. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div className="flex flex-col gap-4 lg:sticky lg:top-4">
      <StatCard
        label={`Total (${method === "BIWEEKLY_CONSERVATIVE" ? "Biweekly, No 3rd Check" : "Monthly Average"})`}
        labelClassName="text-emerald-700 dark:text-emerald-400"
        value={
          <>
            {formatCents(totalMonthlyCents)}
            {incomeIsEstimated && (
              <span className="ml-1.5 align-middle text-xs font-normal text-amber-700 dark:text-amber-400">estimated</span>
            )}
          </>
        }
        caption={
          <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
            {incomeIsEstimated
              ? "Estimated from your synced deposits — confirm a source above to lock it in."
              : (
                <>
                  {includeP2PInIncomeCalc ? "Includes This Month's P2P Income" : "Excludes P2P Income"} ·{" "}
                  <Link href="/settings" className="underline">
                    Change in Settings
                  </Link>
                </>
              )}
          </p>
        }
      />

      <CountWarning
        count={unlabeledP2PCredits.length}
        title="Unconfirmed P2P Income"
        subtitle={`${unlabeledP2PCredits.length} credit${unlabeledP2PCredits.length === 1 ? "" : "s"} already counted as income — confirm, or mark as a reimbursement or recurring income`}
        href="/transactions?status=unlabeledP2P"
        linkLabel="Review Transactions →"
        storageKey="unlabeled-p2p-credit"
        dismiss={dismissUnlabeledP2PCredits}
      />

      <IncomeSuggestions
        suggestions={detected.map((d) => ({
          ...d,
          nextPayDate: d.nextPayDate.toISOString().slice(0, 10),
        }))}
      />

      <ExpectedIncomeThisMonth
        incomes={expected.map((i) => ({
          ...i,
          receivedDate: i.receivedDate ? i.receivedDate.toISOString().slice(0, 10) : null,
          expectedDate: i.expectedDate.toISOString().slice(0, 10),
        }))}
      />

      <AdHocIncomeCard
        entries={adHocIncome.entries.map((e) => ({ ...e, occurredOn: e.occurredOn.toISOString().slice(0, 10) }))}
        totalCents={adHocIncome.totalCents}
      />
      </div>

      <div className="flex flex-col gap-6">
      {incomes.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          No income sources yet. Connect SimpleFIN to detect them automatically,
          or track a paycheck from Transactions.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Recurring</h2>
          <ul className="flex flex-col gap-3">
            {incomes.map((i) => (
              <IncomeRow key={i.id} income={i} status={expectedStatus(i.nextPayDate)} />
            ))}
          </ul>
        </div>
      )}

      {incomePatterns.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">P2P Income Patterns</h2>
          <ul className="flex flex-col gap-3">
            {incomePatterns.map((p) => (
              <PatternRow
                key={p.id}
                pattern={{
                  ...p,
                  ...serializePatternDates(p, monthStart, monthEnd),
                  bucketName: null,
                  debtName: null,
                  billName: null,
                  categoryName: p.category?.name ?? null,
                }}
                buckets={buckets}
                debts={debts}
                categories={categories}
              />
            ))}
          </ul>
        </div>
      )}

      {reimbursementPatterns.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Reimbursements</h2>
          <ul className="flex flex-col gap-3">
            {reimbursementPatterns.map((p) => (
              <PatternRow
                key={p.id}
                pattern={{
                  ...p,
                  ...serializePatternDates(p, monthStart, monthEnd),
                  bucketName: null,
                  debtName: null,
                  billName: p.bill?.name ?? null,
                  categoryName: p.bill?.category?.name ?? null,
                }}
                buckets={buckets}
                debts={debts}
                bills={bills}
                categories={categories}
              />
            ))}
          </ul>
        </div>
      )}
      </div>
      </div>
    </AppShell>
  );
}
