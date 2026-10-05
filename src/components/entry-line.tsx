"use client";

import type { ReactNode } from "react";
import { CheckCircle2, Circle, CircleSlash, Star } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { ExtraPaymentIcon } from "@/components/extra-payment-icon";
import type { PoolBreakdown } from "@/lib/debt-payoff";
import type { PaymentReceipt } from "@/lib/payment-receipt";
import { useReceiptToggle } from "@/components/receipt-toggle";

export type EntryLineState = "due" | "paid" | "expected";

// One entry row shared by every "what's owed / what was paid" ledger that
// wants bills and debt payments to read the same way (2026-09-01 household
// request): a leading status bullet, the date as "Sep 3", a flex spacer,
// then the amount right-aligned. No "Minimum"/"due"/"paid" words — the
// per-payment amount and cadence are already stated in the card subtitle
// right above.
//
//  - due       open bullet; date coloured by the caller (dueDateProximity,
//              src/lib/date.ts) so an overdue obligation reads red, one due
//              soon amber, one further out neutral
//  - paid      filled emerald check; date muted
//  - expected  banknote-arrow-up + all-emerald line — an extra payment
//              toward a debt's principal; `cleared` swaps the leading open
//              bullet for a check once a real synced payment covers it, but
//              a cleared and an uncleared extra otherwise read the same
//              (household request 2026-09-01)
//
// `payoff` marks the payment that takes the balance to $0: a leading star
// replaces the check on a `paid` row, otherwise a trailing star is added.
// `onToggle` turns the row into a <button> (the mark-paid affordance on
// /debts). `inlineAfterDate` sits just after the date, inside the flex-1
// span (the "already accounted for?" toggle). `children` render indented
// under the row for sub-notes (a carried-over note, an "accounted for
// via …" status line, or — for a skippable payoff-plan extra — an inline
// gated confirm). `trailingAction` renders after the amount/payoff star —
// a small icon/text control (the skip/undo affordance on a payoff-plan
// extra line); keep it tight, this sits on an already-dense row. `muted`
// dims and strikes the whole row (a skipped extra or bill) and — every
// current caller of `muted` is a skip, never some other reason to just dim
// a row — also swaps the leading bullet for a slashed circle, so a skipped
// row reads distinctly from a plain still-open one at a glance instead of
// sharing its bullet (real report, 2026-09-14: a skipped bill's open circle
// looked no different from an ordinary still-due one). Only takes over the
// bullet when nothing else already claimed it (a real checkmark/payoff star
// always wins — see leadingIcon below). `receipt` (a paid line's matched
// payment) adds the receipt glyph after the date that toggles its "From
// Receipt" block under the row — skipped on an `onToggle` row, whose whole
// line is already a button.
export function EntryLine({
  state,
  date,
  amountCents,
  payoff = false,
  cleared = false,
  approximate = false,
  muted = false,
  dateTitle,
  dateClassName,
  onToggle,
  disabled = false,
  inlineAfterDate,
  trailingAction,
  children,
  poolBreakdown,
  receipt,
}: {
  state: EntryLineState;
  date: Date;
  amountCents: number;
  payoff?: boolean;
  cleared?: boolean;
  approximate?: boolean;
  muted?: boolean;
  dateTitle?: string;
  dateClassName?: string;
  onToggle?: () => void;
  disabled?: boolean;
  inlineAfterDate?: ReactNode;
  trailingAction?: ReactNode;
  children?: ReactNode;
  // What this line's extra pool was made of — undefined for a plain flat
  // extra with nothing rolled in. Hovering the banknote-arrow icon below then
  // shows the same "Rolled From X" breakdown the /debts Payoff Calendar's
  // day popover already shows (see ExtraPaymentIcon).
  poolBreakdown?: PoolBreakdown;
  receipt?: PaymentReceipt | null;
}) {
  const { trigger: receiptTrigger, panel: receiptPanel } = useReceiptToggle(onToggle ? null : receipt);
  const emerald = state === "expected";
  const showCheck = state === "paid" || (state === "expected" && cleared);
  // A real paid minimum/bill payment that cleared the balance swaps its
  // check for a star inline; a projected/extra payoff line keeps its normal
  // leading icon and gets a trailing star instead (matches the old
  // ExtraLedgerRow / paid-slot treatment in debt-row.tsx).
  const leadingStar = payoff && state === "paid";
  const leadingIcon = leadingStar ? (
    <Star size={15} className="shrink-0 fill-emerald-400 text-emerald-500" aria-label="Pays Off This Debt" />
  ) : showCheck ? (
    <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
  ) : muted ? (
    <CircleSlash size={15} className="shrink-0 text-neutral-400 dark:text-neutral-600" aria-label="Skipped" />
  ) : (
    <Circle size={15} className="shrink-0 text-neutral-400 dark:text-neutral-600" />
  );

  const dateColor =
    dateClassName ??
    (emerald
      ? "text-emerald-700 dark:text-emerald-400"
      : state === "paid"
        ? "text-neutral-500 dark:text-neutral-400"
        : "text-neutral-800 dark:text-neutral-200");
  const amountColor = emerald ? "text-emerald-700 dark:text-emerald-400" : "text-neutral-800 dark:text-neutral-200";

  const inner = (
    <>
      {leadingIcon}
      {state === "expected" && <ExtraPaymentIcon poolBreakdown={poolBreakdown} />}
      <span className={`flex flex-1 items-center gap-1.5 ${dateColor} ${muted ? "line-through opacity-60" : ""}`}>
        <span title={dateTitle}>
          {approximate ? "~" : ""}
          {formatDate(date, { month: "short", day: "numeric" })}
        </span>
        {receiptTrigger}
        {inlineAfterDate}
      </span>
      <span className={`font-medium ${amountColor} ${muted ? "line-through opacity-60" : ""}`}>
        {formatCents(amountCents)}
      </span>
      {payoff && !leadingStar && (
        <span title="Pays Off This Debt" className="shrink-0">
          <Star size={13} className="fill-emerald-400 text-emerald-500" />
        </span>
      )}
      {trailingAction}
    </>
  );

  return (
    <li className="flex flex-col gap-1">
      {onToggle ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onToggle}
          className="flex w-full items-center gap-2 text-left disabled:cursor-default"
        >
          {inner}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2">{inner}</div>
      )}
      {receiptPanel}
      {children}
    </li>
  );
}
