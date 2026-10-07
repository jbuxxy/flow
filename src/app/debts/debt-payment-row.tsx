"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Copy, Info, Pencil, Star, X, XCircle } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate, dueDateProximity } from "@/lib/date";
import { pickPayoffPaymentTime, type PoolBreakdown } from "@/lib/debt-payoff";
import { EntryLine } from "@/components/entry-line";
import { PendingIcon } from "@/components/pending-icon";
import {
  linkPaymentAccountedFor,
  unlinkPaymentAccountedFor,
  markPaymentNotAccountedFor,
  unmarkPaymentNotAccountedFor,
} from "./actions";
import { showToast } from "@/lib/toast";
import type { AccountedForCandidate } from "@/lib/debt-payments";
import { CADENCE_LABEL } from "@/lib/cadence-label";

export type DebtPaymentData = {
  id: string;
  amountCents: number;
  toleranceCents: number | null;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";
  categoryId: string | null;
  categoryName: string | null;
  nextDueDate: string; // ISO date
  // Whether `nextDueDate` lands in the current calendar month. Gates the
  // fallback "Next due …" line below: when nothing's expected this month
  // (`slots` empty) that date is in a future month, and showing it in a
  // this-month ledger reads as next month's obligation leaking in (matches
  // DebtRow's CycleMinimum.nextDueThisMonth, 2026-08-30).
  nextDueThisMonth: boolean;
  lastPaidDate: string | null; // ISO date
  dueDateLocked: boolean;
  // Bubbled down from the Debts nav tab's red-dot badge (see
  // hasDebtsNeedingAttention/debts/page.tsx) — true when this specific
  // payment's due date isn't confirmed yet, or it has a pending "did your
  // minimum change?" review, so the badge lands on the actual card that
  // needs a human instead of stopping at the nav tab or the debt row.
  needsAttention: boolean;
  // See the schema comment on DebtPayment.bucketId — surfaces this card in
  // that Bucket's Bills section too, alongside RecurringBills, AND counts
  // its linked payments toward that bucket's spentCents/monthlyCapCents
  // (getBucketsWithProgress, src/lib/buckets.ts). Never affects the payoff
  // calculator either way, only budget totals.
  bucketId: string | null;
  // The underlying Debt sitting at $0 (2026-08-16, real report: a $0-balance
  // card kept showing a projected next due date months out, which reads as
  // money owed that isn't). Overrides the whole due/paid badge area below
  // with a plain "Paid off" pill and hides "Mark this payment paid" (there's
  // nothing to confirm) and the "still due" badge (nothing's due).
  paidOff: boolean;
  // Stamped the moment the balance itself crossed zero (nextPaidOffDate,
  // debt-payoff.ts) — used with pickPayoffPaymentTime to find which real
  // extraPayment (if any) actually closed the debt, so only that one gets
  // starred "Payoff" instead of every payment made after the debt was done.
  paidOffDate: string | null; // ISO date
  // One entry per expected occurrence of this debt's cadence landing in the
  // current real calendar month (household correction, 2026-08-25 — see
  // debt-row.tsx's CycleMinimum comment: "a cycle in the Flow context is a
  // month," not one cadence-length window ending at the due date) — computed
  // server-side via buildCycleSlots (src/lib/cycle-slots.ts) so this
  // component doesn't need its own cadence math. Usually one slot for
  // MONTHLY/ANNUAL, sometimes 2-3 for WEEKLY/BIWEEKLY (a biweekly BNPL plan
  // making 2 payments in one calendar month).
  slots: { date: string; payment: DebtPaymentPayment | null }[];
  // Real payments this month beyond the expected slot count — paid ahead of
  // schedule, or extra/rounding-up.
  extraPayments: DebtPaymentPayment[];
  // See Debt.ignoreMinimumPayment — a card the household pays ad hoc, with no
  // required minimum. The subtitle reads "No Minimum" instead of "$0.00", and
  // the "$X due / next due" ledger lines are suppressed (there's no minimum
  // owed on the due date), matching DebtRow on /debts and ManualDebtEditor in
  // Account Settings (household request, 2026-09-03). The page mappers fold
  // every paired payment into `extraPayments` and leave `slots` empty for one
  // of these, same as debts/page.tsx.
  ignoreMinimumPayment: boolean;
  // Projected payoff-plan "extra toward principal" allocations landing in the
  // current calendar month (see plannedExtraByDebtInPeriod) — rendered as the
  // same emerald banknote-arrow EntryLine DebtRow shows on /debts
  // (expectedExtras). `confirmed` is derived from real money, not a manual
  // click: each debt's real extra-payment total this month is consumed
  // oldest-projected-line-first, matching payoff-planner.tsx's
  // thisCycleExtrasByDebtId. Empty when the payoff plan is off or routes no
  // extra to this debt this month.
  projectedExtras: {
    date: string;
    amountCents: number;
    isPayoff: boolean;
    confirmed: boolean;
    poolBreakdown?: PoolBreakdown;
  }[];
  // ISO due dates of this month's *covered* minimums the household hasn't
  // skipped — a bigger payment made ahead of the due date satisfied the cycle,
  // but the regular minimum stays listed as an expected payment until skipped
  // (see resolveMinimumLedger, src/lib/minimum-ledger.ts; skip lives on
  // /debts). Optional so a caller without it renders exactly as before.
  coveredMinimums?: string[];
  // See the schema comment on DebtPayment.bucketId's double-counting note —
  // only a debt whose linked account is itself used for transactions has
  // purchases to double-count against in the first place, so the
  // "already accounted for" linker below only ever renders for one.
  accountBudgetTracked: boolean;
};

export type DebtPaymentPayment = {
  id: string;
  amountCents: number;
  occurredOn: string; // ISO date
  pending: boolean;
  // See the schema comment on Transaction.accountedForLinks — every already-
  // bucketed purchase this specific payment has been confirmed to cover
  // (e.g. two same-day Groceries/Fuel purchases on this same card, paid off
  // from checking) so their net amounts shouldn't also count toward this
  // debt's own bucket. Usually empty or one entry, but can be more.
  accountedForBy: { id: string; merchant: string; amountCents: number; occurredOn: string }[];
  // See the schema comment on Transaction.notAccountedFor — the explicit
  // "no, just a payment" answer to the same question, so a decided "no"
  // doesn't keep prompting the same way an unlinked payment would.
  notAccountedFor: boolean;
};

// One full "This cycle" checklist line for a real, linked payment — a
// checkmark plus the "already accounted for" decision (see the schema
// comment on Transaction.accountedForLinks/notAccountedFor),
// merged into one component so the inline gold Copy icon next to the
// payment's own label and the decision panel/status line below it can share
// local state. Three states: undecided (gold icon inline — click opens a
// small panel of candidate purchases plus a "No, just a payment" option),
// linked ("Accounted for via X" status line below, its own X reverts to
// undecided), declined ("Just a payment" status line below, its own X
// reverts to undecided too — same revert affordance either direction,
// 2026-08-19 request). `label` is the caller's fully-formed row text (e.g.
// "Minimum $50.00 — paid Aug 7" for the payment that satisfies a slot, or
// just "Aug 19 · extra" for one that doesn't) — same full-width
// icon/flex-1-label/trailing-amount row layout as DebtRow's own cycle
// checklist (/debts), so the two pages read the same way (2026-08-19
// household request: "make the bucket entry for BNPL look similar").
function LedgerPaymentRow({
  payment,
  label,
  accountBudgetTracked,
  suggestions,
  isPayoff = false,
  // Bucket pages render this row through the shared EntryLine (bullet +
  // "Sep 3" + right-aligned amount, no "Minimum" word) so a debt payment
  // reads the same as a bill in that list (2026-09-01 household request).
  // /bills keeps the fuller `label` treatment.
  bucket = false,
}: {
  payment: DebtPaymentPayment;
  label: string;
  accountBudgetTracked: boolean;
  suggestions: AccountedForCandidate[];
  // The payment that took this debt to $0 — gets the green "pays off" star
  // instead of the plain check, same convention as the dashboard card /
  // payoff calendar (2026-08-28 household request, applies to every debt).
  isPayoff?: boolean;
  bucket?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [linked, setLinked] = useState(payment.accountedForBy);
  const [declined, setDeclined] = useState(payment.notAccountedFor);
  const hasLinks = linked.length > 0;
  const linkedTotalCents = linked.reduce((s, l) => s + l.amountCents, 0);
  const remainingCents = payment.amountCents - linkedTotalCents;
  // Tap-to-reveal instead of a hover-only title — the "Accounted for"/
  // "Balance Paydown" lines render on /buckets, a page browsed mostly on
  // phones, where a `title` tooltip never shows (household report,
  // 2026-09-17: the first version of this explanation was hover-only and
  // unreachable on mobile).
  const [showInfo, setShowInfo] = useState(false);

  // The toggle stays available even with one or more purchases already
  // linked — unlike the old single-match version, a payment can cover
  // several purchases (e.g. two same-day trips settled by one card payment,
  // 2026-09-24 household report), so "already matched" never means "done."
  // Only an explicit "no, just a payment" answer closes it off.
  const accountedForToggle =
    accountBudgetTracked && !declined ? (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        aria-label={open ? "Cancel" : hasLinks ? "Match another purchase?" : "Already accounted for by a purchase?"}
        title={open ? "Cancel" : hasLinks ? "Match another purchase?" : "Already accounted for by a purchase?"}
        className="text-amber-600 dark:text-amber-400 disabled:opacity-50"
      >
        {open ? <X size={11} /> : <Copy size={11} />}
      </button>
    ) : null;

  const panels = (
    <>
      {linked.map((l) => (
        <div
          key={l.id}
          className="ml-[23px] flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400"
        >
          <span className="truncate">
            Accounted for via {l.merchant} · {formatDate(new Date(l.occurredOn), { month: "short", day: "numeric" })}
          </span>
          <button
            onClick={() => {
              if (
                !confirm(
                  "Clear this match? This payment goes back to needing input on whether this purchase already covered it, and it counts toward this debt's bucket again in the meantime.",
                )
              )
                return;
              startTransition(async () => {
                try {
                  await unlinkPaymentAccountedFor(payment.id, l.id);
                  setLinked((prev) => prev.filter((x) => x.id !== l.id));
                  showToast("Match Cleared");
                } catch {
                  showToast("Something Went Wrong", "error");
                }
              });
            }}
            disabled={pending}
            aria-label="Unlink"
            title="Unlink"
            className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {hasLinks && (
        <div className="ml-[23px] flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span>{remainingCents > 0 ? `${formatCents(remainingCents)} still counts` : "Fully accounted for"}</span>
          <button
            onClick={() => setShowInfo((v) => !v)}
            aria-label={showInfo ? "Hide explanation" : "What does this mean?"}
            title={showInfo ? "Hide explanation" : "What does this mean?"}
            className="shrink-0 flex items-center text-neutral-400/70 dark:text-neutral-500/70"
          >
            <Info size={11} />
          </button>
        </div>
      )}
      {showInfo && hasLinks && (
        <p className="ml-[23px] text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
          This payment pays off {linked.map((l) => `${l.merchant} (${formatCents(l.amountCents)})`).join(", ")} —
          already counted toward a bucket, so counting this payment too would double-count it. Up to{" "}
          {formatCents(linkedTotalCents)} of this payment is excluded from this debt&apos;s bucket total for that
          reason
          {remainingCents > 0
            ? ` — the remaining ${formatCents(remainingCents)} wasn't covered by ${linked.length === 1 ? "that purchase" : "those purchases"}, so it still counts as usual`
            : ""}
          .
        </p>
      )}

      {declined && !hasLinks && (
        <>
          <div className="ml-[23px] flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
            <span>Balance Paydown</span>
            <button
              onClick={() => setShowInfo((v) => !v)}
              aria-label={showInfo ? "Hide explanation" : "What does this mean?"}
              title={showInfo ? "Hide explanation" : "What does this mean?"}
              className="shrink-0 flex items-center text-emerald-600/70 dark:text-emerald-400/70"
            >
              <Info size={11} />
            </button>
            <button
              onClick={() => {
                if (
                  !confirm(
                    "Undo this? This payment goes back to needing a call on whether a bucketed purchase already covered it.",
                  )
                )
                  return;
                startTransition(async () => {
                  try {
                    await unmarkPaymentNotAccountedFor(payment.id);
                    setDeclined(false);
                    showToast("Undone");
                  } catch {
                    showToast("Something Went Wrong", "error");
                  }
                });
              }}
              disabled={pending}
              aria-label="Undo"
              title="Undo — needs input again"
              className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
            >
              <X size={11} />
            </button>
          </div>
          {showInfo && (
            <p className="ml-[23px] text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
              Marked as not covering any already-bucketed purchase, so it counts toward this debt&apos;s bucket like
              any other payment.
            </p>
          )}
        </>
      )}

      {open && !declined && (
        <div className="ml-[23px] flex flex-col gap-1">
          {suggestions.map((s) => (
            <button
              key={s.id}
              onClick={() =>
                startTransition(async () => {
                  try {
                    await linkPaymentAccountedFor(payment.id, s.id);
                    setLinked((prev) => [...prev, { id: s.id, merchant: s.merchant, amountCents: s.amountCents, occurredOn: s.occurredOn }]);
                    setOpen(false);
                    showToast("Payment Matched");
                  } catch {
                    showToast("Something Went Wrong", "error");
                  }
                })
              }
              disabled={pending}
              className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-left text-[11px] hover:border-blue-900 dark:hover:border-blue-400 disabled:opacity-50"
            >
              <span className="truncate">
                {s.merchant} · {formatDate(new Date(s.occurredOn), { month: "short", day: "numeric" })}
                {s.bucketName ? ` · ${s.bucketName}` : ""}
              </span>
              <span className="shrink-0 font-medium text-red-600 dark:text-red-400">-{formatCents(s.amountCents)}</span>
            </button>
          ))}
          {!hasLinks && (
            <button
              onClick={() =>
                startTransition(async () => {
                  try {
                    await markPaymentNotAccountedFor(payment.id);
                    setDeclined(true);
                    setOpen(false);
                    showToast("Marked Balance Paydown");
                  } catch {
                    showToast("Something Went Wrong", "error");
                  }
                })
              }
              disabled={pending}
              className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1 text-left text-[11px] text-neutral-600 dark:text-neutral-400 hover:border-neutral-400 dark:hover:border-neutral-600 disabled:opacity-50"
            >
              <XCircle size={12} className="shrink-0" />
              No, just a payment
            </button>
          )}
        </div>
      )}
    </>
  );

  if (bucket) {
    return (
      <EntryLine
        state="paid"
        date={new Date(payment.occurredOn)}
        amountCents={payment.amountCents}
        payoff={isPayoff}
        pending={payment.pending}
        inlineAfterDate={accountedForToggle}
      >
        {panels}
      </EntryLine>
    );
  }

  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex w-full items-center gap-2">
        {isPayoff ? (
          <Star size={15} className="shrink-0 fill-emerald-400 text-emerald-500" aria-label="Payoff" />
        ) : (
          <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <span className="flex flex-1 items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
          {label}
          {payment.pending && <PendingIcon />}
          {accountedForToggle}
        </span>
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{formatCents(payment.amountCents)}</span>
      </div>
      {panels}
    </li>
  );
}

// "Minimum {amount} — paid/due {date}" — the same wording DebtRow uses on
// /debts for its own "This cycle" checklist (2026-08-19: bucket entries
// asked to "look similar").
function minimumLabel(
  amountCents: number,
  isoDate: string,
  status: "paid" | "due",
  // The actual payment that filled this slot, when status is "paid" — a
  // single payment that covered the minimum and then some is split so the
  // overage reads as extra toward principal, matching DebtRow on /debts.
  paidCents?: number,
): string {
  const split =
    status === "paid" && paidCents != null && paidCents > amountCents
      ? ` + Extra ${formatCents(paidCents - amountCents)}`
      : "";
  return `Minimum ${formatCents(amountCents)}${split} — ${status} ${formatDate(new Date(isoDate), { month: "short", day: "numeric" })}`;
}

// The debt-payment counterpart to BillRow (src/app/bills/bill-row.tsx) —
// rendered inside DebtRow for a debt's tracked recurring payment. Unlike a
// bill, every matching transaction gets listed here (not just the one that
// completed a cycle — see matchDebtPayments in src/lib/debt-payments.ts),
// with a running total, and a still-open cycle with partial payments shows
// what's left.
export function DebtPaymentRow({
  debtPayment,
  // Suggested purchases for the "already accounted for" linker below, keyed
  // by payment transaction id (see getAccountedForSuggestions,
  // src/lib/debt-payments.ts) — computed server-side for every visible
  // payment, same convention as ReimbursementLinker's own suggestions prop.
  accountedForSuggestions = {},
  // "bucket" renders the payment ledger through the shared EntryLine so a
  // debt payment reads the same as a bill in a bucket's Recurring list
  // (2026-09-01 household request). The default keeps the "Minimum … —
  // paid/due …" wording used on /bills.
  variant = "default",
}: {
  debtPayment: DebtPaymentData;
  accountedForSuggestions?: Record<string, AccountedForCandidate[]>;
  variant?: "default" | "bucket";
}) {
  const bucket = variant === "bucket";
  // The one real payment that gets the "Payoff" star/label once the debt
  // reads $0 — see pickPayoffPaymentTime (debt-payoff.ts) for why that's
  // not just whichever extra payment happens to be latest.
  const extraPaymentsWithDates = debtPayment.extraPayments.map((p) => ({ ...p, occurredOn: new Date(p.occurredOn) }));
  const payoffExtraPaymentTime = pickPayoffPaymentTime(
    extraPaymentsWithDates,
    debtPayment.paidOff ? 0 : 1,
    debtPayment.paidOffDate ? new Date(debtPayment.paidOffDate) : null,
  );
  const latestExtraPaymentId =
    payoffExtraPaymentTime !== null
      ? (extraPaymentsWithDates.find((p) => p.occurredOn.getTime() === payoffExtraPaymentTime)?.id ?? null)
      : null;

  return (
    <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-600 dark:text-neutral-400">
            {debtPayment.needsAttention && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-red-600" aria-label="Needs Attention" title="Needs Attention" />
            )}
            <span>
              {debtPayment.ignoreMinimumPayment ? "No Minimum" : formatCents(debtPayment.amountCents)} ·{" "}
              {CADENCE_LABEL[debtPayment.cadence]} ·{" "}
              {debtPayment.categoryName ? (
                <span className="text-emerald-700 dark:text-emerald-400">{debtPayment.categoryName}</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-400">Uncategorized</span>
              )}
            </span>
          </p>
        </div>
        {/* This payment's own amount/cadence/category/tolerance/due-date/
            bucket all live in Settings now (Account Settings for a synced
            debt, the debt's own card for a manual one) — never edited
            inline here, on the /bills or /buckets browsing surfaces this
            row also renders on (household request, 2026-09-12: "I
            shouldn't be able to edit accounts here, only in settings").
            "Mark this payment paid" and the ledger below stay available
            either way — those aren't term-editing. */}
        <Link
          href="/settings/accounts"
          aria-label="Edit in Settings"
          title="Edit in Settings"
          className="shrink-0 text-xs text-blue-900 dark:text-blue-300 hover:underline"
        >
          <Pencil size={14} />
        </Link>
      </div>

      {/* Same "This cycle" checklist DebtRow already shows on /debts —
          oldest-first, one row per expected occurrence this calendar month
          (see DebtPaymentData.slots — computed server-side via
          buildCycleSlots, src/lib/cycle-slots.ts) plus one row per real
          extra payment beyond that, all sharing the full-width
          icon/flex-1-label/trailing-amount layout (2026-08-19 household
          request: bucket entries should "look similar" to the /debts page).
          One or more slots depending on cadence — usually one for
          MONTHLY/ANNUAL, sometimes 2-3 for WEEKLY/BIWEEKLY (a biweekly BNPL
          plan making 2 payments in one calendar month). */}
      {/* A paid-off debt still shows this cycle's actual payments (the
          minimum plus whatever finished it off — 2026-08-28 household
          request: "both should be showing with checkmarks"), just without
          the still-due / next-due rows. Once a fresh cycle opens with no
          payments in it, the whole block collapses and only the card's
          "Paid Off" badge remains. */}
      {(debtPayment.slots.some((s) => s.payment) ||
        debtPayment.extraPayments.length > 0 ||
        debtPayment.projectedExtras.length > 0 ||
        (!debtPayment.paidOff &&
          !debtPayment.ignoreMinimumPayment &&
          (debtPayment.slots.length > 0 || debtPayment.nextDueThisMonth))) && (
        <div className="flex flex-col gap-1.5">
          <ul className="flex flex-col gap-1.5 text-xs">
            {(() => {
              // One chronological ledger (household request, 2026-10-03:
              // "list extra payments chronologically with the minimum due
              // date") — same merge-by-date DebtRow does on /debts. Each
              // group pushes {sortMs, el}; a stable sort keeps same-day rows
              // in group order (minimum, covered, real extras, projected).
              const rows: { sortMs: number; el: ReactNode }[] = [];
              const at = (iso: string) => new Date(iso).getTime();
              const minimumRows =
                debtPayment.slots.length > 0
              ? debtPayment.slots.map((slot) =>
                  slot.payment ? (
                    <LedgerPaymentRow
                      key={slot.payment.id}
                      payment={slot.payment}
                      label={minimumLabel(
                        debtPayment.amountCents,
                        slot.payment.occurredOn,
                        "paid",
                        slot.payment.amountCents,
                      )}
                      accountBudgetTracked={debtPayment.accountBudgetTracked}
                      suggestions={accountedForSuggestions[slot.payment.id] ?? []}
                      bucket={bucket}
                    />
                  ) : debtPayment.paidOff ? null : bucket ? (
                    <EntryLine
                      key={slot.date}
                      state="due"
                      date={new Date(slot.date)}
                      amountCents={debtPayment.amountCents}
                      approximate={!debtPayment.dueDateLocked}
                      dateClassName={dueDateProximity(new Date(slot.date)).textClassName}
                      dateTitle={dueDateProximity(new Date(slot.date)).label}
                    />
                  ) : (
                    <li key={slot.date} className="flex w-full items-center gap-2">
                      <Circle size={15} className="shrink-0 text-neutral-400 dark:text-neutral-600" />
                      <span className="flex-1 text-neutral-800 dark:text-neutral-200">
                        {debtPayment.dueDateLocked ? "" : "~"}
                        {minimumLabel(debtPayment.amountCents, slot.date, "due")}
                      </span>
                    </li>
                  ),
                )
              : debtPayment.paidOff || !debtPayment.nextDueThisMonth || debtPayment.ignoreMinimumPayment
                ? null
                : bucket ? (
                    <EntryLine
                      key="next-due"
                      state="due"
                      date={new Date(debtPayment.nextDueDate)}
                      amountCents={debtPayment.amountCents}
                      approximate={!debtPayment.dueDateLocked}
                      dateClassName={dueDateProximity(new Date(debtPayment.nextDueDate)).textClassName}
                      dateTitle={dueDateProximity(new Date(debtPayment.nextDueDate)).label}
                    />
                  ) : (
                    // No expected occurrence lands in the current calendar
                    // month as a slot, but the tracked next due date itself is
                    // still this month. Suppressed when it's a future month
                    // (the usual case once `slots` is empty) — a this-month
                    // ledger shouldn't show next month's due date (2026-08-30).
                    <li key="next-due" className="flex w-full items-center gap-2">
                      <Circle size={15} className="shrink-0 text-neutral-400 dark:text-neutral-600" />
                      <span className="flex-1 text-neutral-800 dark:text-neutral-200">
                        Next due {formatDate(new Date(debtPayment.nextDueDate), { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    </li>
                  );
              // Sort key per minimum row: the real payment's date, the open
              // slot's due date, or (fallback pointer) nextDueDate.
              if (Array.isArray(minimumRows)) {
                debtPayment.slots.forEach((slot, idx) => {
                  const el = minimumRows[idx];
                  if (el) rows.push({ sortMs: at(slot.payment ? slot.payment.occurredOn : slot.date), el });
                });
              } else if (minimumRows) {
                rows.push({ sortMs: at(debtPayment.nextDueDate), el: minimumRows });
              }
              // A minimum an earlier, bigger payment already covered — still
              // an expected payment on this card (open bullet, same as any due
              // line) until skipped on /debts. Bucket variant only: the
              // default layout's "Minimum … — due" wording isn't used here
              // (2026-09-20 household request).
              if (bucket && !debtPayment.paidOff) {
                for (const date of debtPayment.coveredMinimums ?? []) {
                  rows.push({
                    sortMs: at(date),
                    el: (
                      <EntryLine
                        key={`covered-${date}`}
                        state="due"
                        date={new Date(date)}
                        amountCents={debtPayment.amountCents}
                        approximate={!debtPayment.dueDateLocked}
                      >
                        <p className="ml-[23px] text-[11px] text-neutral-500 dark:text-neutral-400">
                          Already covered by an earlier payment.
                        </p>
                      </EntryLine>
                    ),
                  });
                }
              }
              for (const p of debtPayment.extraPayments) {
                // isPayoff: same "the latest real payment this cycle, once
                // the debt sits at $0" convention DebtRow uses on /debts —
                // without narrowing to the latest one, every real extra
                // payment this cycle got starred "Payoff" once the debt paid
                // off, not just the one that actually closed it (real report,
                // 2026-09-07: Sam's Club Card's routine Sep 1 $101 payment
                // starred "Payoff" — the real close was a separate,
                // untraceable balance-only payoff with no transaction of its
                // own to show here at all).
                const isPayoff = debtPayment.paidOff && p.id === latestExtraPaymentId;
                rows.push({
                  sortMs: at(p.occurredOn),
                  el: (
                    <LedgerPaymentRow
                      key={p.id}
                      payment={p}
                      label={`${formatDate(new Date(p.occurredOn), { month: "short", day: "numeric" })} · ${
                        isPayoff ? "Payoff" : "Extra"
                      }`}
                      isPayoff={isPayoff}
                      accountBudgetTracked={debtPayment.accountBudgetTracked}
                      suggestions={accountedForSuggestions[p.id] ?? []}
                      bucket={bucket}
                    />
                  ),
                });
              }
              // Projected payoff-plan extras this month — the emerald
              // banknote-arrow line, same as DebtRow's expectedExtras on
              // /debts. `cleared` (a real synced payment already covers it)
              // swaps the open bullet for a check but the line stays green.
              debtPayment.projectedExtras.forEach((x, i) => {
                rows.push({
                  sortMs: at(x.date),
                  el: (
                    <EntryLine
                      key={`projected-extra-${i}`}
                      state="expected"
                      cleared={x.confirmed}
                      date={new Date(x.date)}
                      amountCents={x.amountCents}
                      payoff={x.isPayoff}
                      poolBreakdown={x.poolBreakdown}
                    />
                  ),
                });
              });
              return rows.sort((a, b) => a.sortMs - b.sortMs).map((r) => r.el);
            })()}
          </ul>
        </div>
      )}

    </div>
  );
}
