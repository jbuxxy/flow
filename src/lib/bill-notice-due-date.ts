// Due-date half of the bill-notice pipeline (see bill-notice-sync.ts) — pure
// date rules, kept apart from the DB code so they're unit-testable.
//
// Debts and bills are treated differently on purpose (household decision,
// 2026-10-19): a card/loan's due day is fixed, so a statement naming a
// different day is worth asking about (DebtDueDateReview); a utility's due
// date wobbles a few days every month, so its notice just becomes that
// cycle's date without a question.

import { addMonthsClamped } from "@/lib/cadence-step";
import { DAY_MS } from "@/lib/date";

function daysInUtcMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

// Whether a statement's due date names a different day-of-month than the
// tracked MONTHLY due date. Month-end clamping counts as the same day either
// way — a 31st due day is tracked as Nov 30, and a statement for a 31st-due
// card says Feb 28.
export function dueDayDiffers(noticeDueDate: Date, trackedDueDate: Date): boolean {
  const noticeDay = noticeDueDate.getUTCDate();
  const trackedDay = trackedDueDate.getUTCDate();
  if (noticeDay === trackedDay) return false;
  if (Math.min(noticeDay, daysInUtcMonth(trackedDueDate)) === trackedDay) return false;
  if (Math.min(trackedDay, daysInUtcMonth(noticeDueDate)) === noticeDay) return false;
  return true;
}

// The DebtPayment.nextDueDate to write once the household confirms a
// statement's due date. The statement's own due date is a real occurrence;
// it's the *next* one unless a payment already posted on/after the
// statement arrived (that payment paid this statement — e.g. a card paid
// Oct 8 against a Sep 30 statement due Oct 22 is next due Nov 22), and a
// statement whose due date has already gone by rolls forward to the first
// occurrence that hasn't. Anchored on the statement's day, so a 31st doesn't
// stick at the 30th after a short month.
export function confirmedDebtDueDate(opts: {
  observedDueDate: Date;
  statementDate: Date;
  lastPaidDate: Date | null;
  today: Date;
}): Date {
  const anchorDay = opts.observedDueDate.getUTCDate();
  let steps = opts.lastPaidDate && opts.lastPaidDate >= opts.statementDate ? 1 : 0;
  let date = addMonthsClamped(opts.observedDueDate, steps, anchorDay);
  while (date < opts.today) date = addMonthsClamped(opts.observedDueDate, ++steps, anchorDay);
  return date;
}

// How far a bill notice's due date may sit from the tracked next due date
// and still be the same cycle. Wider than any real utility wobble, narrower
// than half a month: anything farther is a different cycle (the tracker
// already rolled past a paid bill, or an old notice), never a correction.
const BILL_SAME_CYCLE_DAYS = 10;

// The quiet bill-side update: the notice's due date replaces the tracked
// next due date only when it's still upcoming, differs, and is plainly the
// same cycle. Null = leave the bill alone.
export function billNoticeDueDateUpdate(noticeDueDate: Date | null, trackedNextDueDate: Date, today: Date): Date | null {
  if (!noticeDueDate || noticeDueDate < today) return null;
  const diffDays = Math.abs(noticeDueDate.getTime() - trackedNextDueDate.getTime()) / DAY_MS;
  if (diffDays === 0 || diffDays > BILL_SAME_CYCLE_DAYS) return null;
  return noticeDueDate;
}

// SuggestionDismissal (kind DEBT_DUE_DATE_EMAIL) key for a declined due-date
// review — per tracker per statement day, so declining "the 22nd" stops
// every later statement re-asking it, while a statement naming yet another
// day still asks.
export const DEBT_DUE_DATE_DISMISS_KIND = "DEBT_DUE_DATE_EMAIL";
export function debtDueDateDismissKey(debtPaymentId: string, noticeDueDate: Date): string {
  return `${debtPaymentId}:${noticeDueDate.getUTCDate()}`;
}
