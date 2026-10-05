"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Circle, CircleDot, CircleSlash, Clock, Star, Target, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatISODate } from "@/lib/date";
import { showToast } from "@/lib/toast";
import { payoffBadgeLabel, principalTowardDebtCents } from "@/lib/upcoming-bills-shared";
import { ExtraPaymentIcon } from "@/components/extra-payment-icon";
import type { PoolBreakdown } from "@/lib/debt-payoff";

export type UpcomingBillData = {
  id: string;
  name: string;
  kind: "bill" | "debt" | "pattern";
  // What's owed this week (bill amount, or debt minimum + planned payoff extra).
  expectedCents: number;
  // What landed toward it this week.
  paidCents: number;
  // Surplus beyond expectedCents — money toward debt principal over and above
  // the minimum and the payoff plan. Always 0 for a bill.
  extraCents: number;
  // Full payoff-plan extra allocated this week (drives principalTowardDebtCents
  // once paid).
  plannedExtraCents: number;
  // Bare minimum obligation for this week's occurrence, before any payment —
  // the denominator for the "$X / $Y" partial headline (expectedCents folds
  // in the full plan extra and isn't the right basis).
  minimumDueCents: number;
  // Reimbursement credits already netting this bill's payment this cycle.
  reimbursedCents: number;
  dueDate: string;
  // The minimum / bill obligation is covered.
  paid: boolean;
  // A household Skip This Cycle decision covers this week — same slashed-
  // circle bullet EntryLine/BillRow already show elsewhere (household
  // request, 2026-09-14), and excluded from stillDueCents/paidPct the same
  // way `paid` is — nothing's actually owed either way. For a debt row, only
  // a skipped covered minimum (DebtMinimumSkip).
  skipped: boolean;
  // This week's payment took the debt's balance to zero.
  paysOff: boolean;
  // The payoff plan projects this week's own planned extra to take the
  // balance to zero, whether or not that's actually landed/confirmed yet —
  // drives the "For Payoff!" badge ahead of the real thing (a still-open
  // bullet, not the star `paysOff` alone earns) so a household can see a
  // payoff coming the same way it already sees any other planned extra.
  // Always true once `paysOff` itself is (the real thing is also, trivially,
  // what was planned).
  plannedPayoff: boolean;
  // This debt is part of the household's active debt-payoff plan — drives the
  // green target marker, whether or not extra is routed to it this week.
  inPayoffPlan: boolean;
  // False when dueDate is a projection (a BNPL plan's rolling "last real
  // payment + cadence" guess, or a revolving debt's inferred date) rather
  // than a confirmed one — same "~" treatment /debts already gives it
  // (debt-row.tsx's dueDateLocked). Always true for a bill.
  dueDateConfirmed: boolean;
  // True only for the rare row that reads unpaid while the debt's own
  // synced balance already shows $0 — drives a small "balance updated,
  // payment details pending" note instead of an unexplained contradiction
  // against the dashboard's "Paid Off" badge. Always false for a bill.
  pendingBalanceConfirmation: boolean;
  // What this week's payoff-plan extra pool was made of — undefined for a
  // bill, a debt with no plan extra this week, or a retrospective ("Last
  // Week's Bills") row (the persisted snapshot only kept the total, not the
  // breakdown). Drives the same hover "Rolled From X" breakdown the /debts
  // Payoff Calendar's icon shows (household request, 2026-09-28).
  poolBreakdown?: PoolBreakdown;
};

export function UpcomingBillsCard({
  bills,
  aiSummary,
  allPaid,
  onDismiss,
  title = "This Week's Bills",
  // Title Case, drives both the "$X Still Due <Period>" chrome line and the
  // (lowercased) "No bills or subscriptions due <period>." sentence — see
  // the retrospective "Last Week's Bills" card, which passes "Last Week".
  period = "This Week",
  // "9/6–9/12" — the same Sun–Sat window `bills` was actually pulled from
  // (see page.tsx's weekRangeLabel/currentWeekBounds), shown next to the
  // title so it's clear at a glance which week this card means without
  // having to count backward from "This Week"/"Last Week" (household
  // request, 2026-09-07).
  dateRange,
}: {
  bills: UpcomingBillData[];
  aiSummary: string | null;
  allPaid: boolean;
  // Omitted entirely (not just false) for a retrospective card — there's
  // nothing to dismiss about history.
  onDismiss?: () => Promise<void>;
  title?: string;
  period?: string;
  dateRange?: string;
}) {
  const [hidden, setHidden] = useState(false);
  const [, startTransition] = useTransition();

  if (hidden) return null;

  // expectedCents is already net of anything paid toward the obligation
  // (it's built from the debt's live rolling amount due) — don't subtract
  // paidCents again. A skipped bill is excluded the same as a paid one —
  // nothing's actually owed either way.
  const stillDueCents = bills.filter((b) => !b.paid && !b.skipped).reduce((s, b) => s + b.expectedCents, 0);
  // Cycle payment progress: what's landed toward this week's obligations vs.
  // the full expected total (paid + still due). A thin bar under the summary,
  // same at-a-glance language as the bucket rings.
  const paidCents = bills.reduce((s, b) => s + b.paidCents, 0);
  const cycleTotalCents = paidCents + stillDueCents;
  const paidPct = cycleTotalCents > 0 ? Math.round((paidCents / cycleTotalCents) * 100) : 0;

  return (
    <div className="relative rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      {allPaid && onDismiss && (
        <button
          type="button"
          onClick={() => {
            setHidden(true);
            startTransition(async () => {
              try {
                await onDismiss();
                showToast("Dismissed");
              } catch {
                showToast("Something Went Wrong", "error");
              }
            });
          }}
          aria-label="Dismiss"
          title="Dismiss Until Next Week"
          className="absolute right-3 top-3 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
        >
          <X size={16} />
        </button>
      )}

      <h2 className="mb-2 flex items-baseline gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
        {title}
        {dateRange && (
          <span className="text-xs font-normal text-gray-400 dark:text-neutral-500">{dateRange}</span>
        )}
      </h2>

      <p className="mb-3 text-sm text-neutral-700 dark:text-neutral-300">
        {bills.length === 0
          ? `No bills or subscriptions due ${period.toLowerCase()}.`
          : (aiSummary ?? `${formatCents(stillDueCents)} Still Due ${period}`)}
      </p>

      {bills.length > 0 && cycleTotalCents > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-blue-100 dark:bg-neutral-800">
            <div
              className="chart-bar h-full rounded-full bg-emerald-500 transition-[width] duration-300"
              style={{ width: `${paidPct}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-neutral-400">
            {paidPct}% Paid
          </span>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {bills.map((b) => {
          const netCents = b.expectedCents - b.reimbursedCents;
          // "$X / $Y" only reads honestly against the bare minimum. Measured
          // against expectedCents (minimum + the whole plan extra) the
          // denominator double-counts anything paid past the minimum — a $101
          // payment on a no-minimum $140.80 payoff target showed "$101 /
          // $241.80". So the fraction shows only when a payment is genuinely
          // short of this week's minimum; anything paid toward the plan extra
          // (or a synced balance the card feed hasn't caught up to) gets its
          // own "$X Paid" line while the plan target keeps reading in full.
          const paidTowardMinimumCents = Math.min(b.paidCents, b.minimumDueCents);
          const behindOnMinimum =
            !b.paid && b.minimumDueCents > 0 && b.paidCents > 0 && paidTowardMinimumCents < b.minimumDueCents;
          const showPaidLine = !b.paid && !behindOnMinimum && b.paidCents > 0;
          // Everything this week's payment(s) put toward principal — true
          // surplus beyond expected, plus the payoff-plan's planned extra
          // once it has landed (b.paid guarantees receivedCents covered it).
          const principalCents = principalTowardDebtCents(b);
          // "Paid Off!", or "+$X For Payoff!" only when $X is additional to a
          // minimum on the same row — see payoffBadgeLabel.
          const payoffBadge = payoffBadgeLabel(b, formatCents);
          // Extra beyond this cycle's minimum, shown as an identical sub-line
          // whether it's still an obligation (unpaid — the payoff-plan
          // allocation) or real money that already landed (paid — the
          // surplus), so a paid row and an unpaid one read the exact same
          // (household request 2026-09-01). A payoff gets the celebratory
          // badge above instead.
          const extraCents = b.paid ? principalCents : b.plannedExtraCents;
          const showExtraLine = !payoffBadge && extraCents > 0;
          const headline = behindOnMinimum
            ? `${formatCents(paidTowardMinimumCents)} / ${formatCents(b.minimumDueCents)}`
            : b.paid && b.paidCents > 0
              ? formatCents(b.paidCents)
              : formatCents(b.expectedCents);
          return (
            <li key={b.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 text-neutral-800 dark:text-neutral-200">
                  {b.paysOff ? (
                    <span
                      role="img"
                      aria-label="This Week's Payment Pays Off This Debt"
                      title="This Week's Payment Pays Off This Debt"
                      className="flex shrink-0"
                    >
                      <Star size={16} className="fill-emerald-400 text-emerald-500" />
                    </span>
                  ) : b.paid ? (
                    <span
                      role="img"
                      aria-label="Paid This Week"
                      title="Paid This Week"
                      className="flex shrink-0 text-emerald-600 dark:text-emerald-400"
                    >
                      <CheckCircle2 size={16} />
                    </span>
                  ) : b.paidCents > 0 ? (
                    <span
                      role="img"
                      aria-label="Partially Paid — Obligation Not Yet Covered"
                      title="Partially Paid — Obligation Not Yet Covered"
                      className="flex shrink-0 text-amber-500 dark:text-amber-400"
                    >
                      <CircleDot size={16} />
                    </span>
                  ) : b.skipped ? (
                    <span
                      role="img"
                      aria-label="Skipped This Cycle"
                      title="Skipped This Cycle"
                      className="flex shrink-0 text-neutral-400 dark:text-neutral-600"
                    >
                      <CircleSlash size={16} />
                    </span>
                  ) : (
                    <span
                      role="img"
                      aria-label="Not Yet Paid"
                      title="Not Yet Paid"
                      className="flex shrink-0 text-neutral-300 dark:text-neutral-600"
                    >
                      <Circle size={16} />
                    </span>
                  )}
                  <span className="truncate">{b.name}</span>
                  {b.inPayoffPlan && (
                    <span
                      role="img"
                      aria-label="In The Debt Payoff Plan"
                      title="In The Debt Payoff Plan"
                      // -mt-px: the 13px reticle sits ~1px low against the
                      // cap-height of the name text at its geometric center —
                      // nudge it onto the optical center.
                      className="flex shrink-0 -mt-px text-emerald-600 dark:text-emerald-400"
                    >
                      <Target size={13} />
                    </span>
                  )}
                </span>
                <span
                  // Struck through when skipped — matches BillRow/EntryLine's
                  // own muted treatment for the exact same decision
                  // elsewhere (household request, 2026-09-14). Just this
                  // amount+date span, not the row's name — same split
                  // BillRow's own "Skipped {date}" line already draws.
                  className={`flex shrink-0 items-center gap-1.5 ${
                    b.skipped ? "text-neutral-400 line-through opacity-70 dark:text-neutral-600" : "text-neutral-600 dark:text-neutral-400"
                  }`}
                >
                  <span title={b.dueDateConfirmed ? undefined : "Approximate — Not Yet Confirmed"}>
                    {headline} · {b.dueDateConfirmed ? "" : "~"}
                    {formatISODate(b.dueDate, { month: "short", day: "numeric" })}
                  </span>
                </span>
              </div>
              {payoffBadge && (
                <p className="flex items-center gap-1 pl-6 text-xs text-emerald-700 dark:text-emerald-400">
                  <ExtraPaymentIcon poolBreakdown={b.poolBreakdown} />
                  {payoffBadge}
                </p>
              )}
              {showExtraLine && (
                <p className="flex items-center gap-1 pl-6 text-xs text-emerald-700 dark:text-emerald-400">
                  <ExtraPaymentIcon poolBreakdown={b.poolBreakdown} />
                  {formatCents(extraCents)} Extra
                </p>
              )}
              {showPaidLine && (
                <p className="flex items-center gap-1 pl-6 text-xs text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 size={13} className="shrink-0" />
                  {formatCents(b.paidCents)} Paid
                </p>
              )}
              {b.pendingBalanceConfirmation && (
                <p
                  className="flex items-center gap-1 pl-6 text-xs text-gray-500 dark:text-neutral-400"
                  title="The account's synced balance already reflects this, but the payment itself hasn't posted as a transaction yet."
                >
                  <Clock size={13} className="shrink-0" />
                  Balance Updated — Payment Details Pending
                </p>
              )}
              {b.reimbursedCents > 0 && (
                <p
                  className="pl-6 text-xs text-emerald-700 dark:text-emerald-400"
                  title={`Net ${formatCents(netCents)}`}
                >
                  − {formatCents(b.reimbursedCents)} Reimbursed · Net {formatCents(netCents)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
