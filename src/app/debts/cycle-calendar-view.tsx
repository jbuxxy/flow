"use client";

import { useCallback, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { BanknoteArrowUp, CheckCircle2, CircleSlash, Clock, Receipt, Star, Target } from "lucide-react";
import { formatCents } from "@/lib/money";
import { useDismissOnScroll } from "@/lib/use-dismiss-on-scroll";
import type { PoolBreakdown } from "@/lib/debt-payoff";

// One line item landing on a specific day within the rendered month — a
// real payment already made ("paid"), a real minimum not yet paid ("due"),
// or a projected extra/future-minimum payment ("expected"). Day cells are
// colored by the "most significant" status present that day (paid >
// due/expected) rather than listing every status separately — a household
// glancing at the grid cares "did something happen/will something happen
// here," not a status legend.
export type CalendarDayEvent = {
  // "bill" is a RecurringBill / subscription occurrence — only the dashboard's
  // "Payment Calendar" mixes these in (household request, 2026-09-10); the
  // /debts payoff calendar stays debt-only and never sets this. A bill event
  // carries only `debtName` (its name), `amountCents` and `status` — none of
  // the payoff-plan fields below apply. Undefined = a debt payment.
  kind?: "debt" | "bill";
  debtName: string;
  // Absent for a payoff detected purely from a synced balance drop to
  // $0 (see getPaymentCalendarThisCycle) — there's no matching payment
  // transaction to read a real amount from, so the line shows without one
  // rather than inventing a number.
  amountCents?: number;
  // "skipped": a household Skip This Cycle decision (BillCycleSkip) covers
  // this occurrence — bill-only (a payoff-plan extra has its own separate
  // skip, PayoffExtraSkip, never surfaced on this calendar). Drives a
  // slashed-circle icon and struck-through text, and doesn't count toward a
  // day's "paid"/"pending" coloring — nothing's actually owed either way
  // (household request, 2026-09-14).
  status: "paid" | "due" | "expected" | "skipped";
  // Whether this debt is counted in the household's debt payoff plan
  // (Debt.includeInPayoffPlan) — badged with the same Target icon Account
  // Settings uses for "Included in the debt payoff plan," so a payment from
  // an excluded debt (shown here too, alongside the others) is still
  // visually distinguishable from one the attack order is actually driving.
  inPlan: boolean;
  // True when this specific payment is projected to bring its debt to $0 —
  // bubbles up to a star badge on the day cell itself (not just the
  // popover line), so a payoff day is spottable at a glance on the grid.
  isPayoff?: boolean;
  // What this paycheck's extra pool was made of — undefined for
  // paid/due (minimum) events, or an expected/extra event that's just the
  // flat per-paycheck amount with nothing rolled in.
  poolBreakdown?: PoolBreakdown;
  // True when this line is an extra payoff-plan payment. On an "expected"
  // line that's implicit (every "expected" line is extra); this flag also
  // marks a *real* "paid" payment that ran past the cycle's minimum, so the
  // day it actually posted gets the same extra-payment badge as the day the
  // plan projected it for (household request, 2026-09-08).
  isExtraPayment?: boolean;
  // True for a "paid" event with no real transaction behind it at all — a
  // debt's own balance already confirms it (real money, not a guess), but
  // no bank or account transaction has posted to point at yet (see
  // getPaymentCalendarThisCycle's PayoffExtraSnapshot/paidOffDate fallback).
  // Keeps the cell green (it did happen) and the payoff star, but swaps the
  // checkmark for a small "pending" note instead of claiming a confirmation
  // Flow hasn't actually seen — same distinction the dashboard's own bills
  // card draws (UpcomingBillsCard's pendingBalanceConfirmation).
  pendingConfirmation?: boolean;
};

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// The day popover is rendered into a portal at document.body with
// position:fixed, not as an `absolute` child of its day cell. Both callers
// (the dashboard content carousel, and /debts) sit inside an
// `overflow-hidden` / `overflow-x-hidden` ancestor that would otherwise clip
// it — an edge-column day's popover got cut off on the left/right, and a
// bottom-row day's got cut off below. Fixed + portal + a viewport-margin
// clamp keeps it fully on screen no matter which cell opened it.
// Wide enough that a real debt name ("Sam's Club® World Elite Mastercard®
// (1234)") wraps to at most 2 lines on its own row instead of fighting the
// amount/icon block for width on one line (that's what forced 3+ line
// entries and a scrollbar in a real household's popover, 2026-09-01).
const POPOVER_WIDTH = 272;
const VIEWPORT_MARGIN = 8;

// A real calendar-month grid for one cycle, with days that have a payment
// (real or projected) highlighted — click (mobile, no hover) or hover
// (desktop) a highlighted day to see what lands on it. No dependency on
// dnd-kit or any editing affordance: this is a read-only alternate view of
// the same data the card list shows, toggled from PayoffPlanner.
export function CycleCalendarView({
  monthDate,
  eventsByDay,
  fillHeight = false,
}: {
  monthDate: Date;
  eventsByDay: Map<number, CalendarDayEvent[]>;
  // Stretch the day grid to fill the parent's height (the parent must give it
  // a bounded height). The dashboard carousel passes this so the calendar
  // card ends up exactly as tall as the Net Worth / Bucket Spending cards
  // regardless of whether the month spans 5 or 6 week-rows. /debts leaves it
  // off — there the grid is content-sized as before.
  fillHeight?: boolean;
}) {
  const [openDay, setOpenDay] = useState<number | null>(null);
  // Bounding rect of the day cell that opened the popover, captured at open
  // time — the popover is position:fixed (see POPOVER_WIDTH comment above),
  // so it's placed off this rect rather than off the cell's own box.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // No SSR guard needed for the createPortal below: anchorRect is only ever
  // set from a client pointer event (getBoundingClientRect), so the portal
  // branch can't render during SSR or the first hydration pass.
  const open = useCallback((day: number, el: HTMLElement) => {
    setAnchorRect(el.getBoundingClientRect());
    setOpenDay(day);
  }, []);
  const close = useCallback(() => {
    setOpenDay(null);
    setAnchorRect(null);
  }, []);

  // The popover is position:fixed (see POPOVER_WIDTH comment) — dismiss it on
  // any scroll/resize so it never hangs detached from its day cell.
  useDismissOnScroll(openDay !== null, close);

  // UTC for the grid itself — every date feeding `eventsByDay` (payment
  // occurredOn, due dates, projected paycheck dates) is a `@db.Date` value,
  // stored and meant as UTC midnight for a specific calendar day (see
  // src/lib/date.ts's formatDate doc comment). Reading it with local
  // getters in a browser west of UTC (e.g. America/Denver) silently
  // rewinds it by a day — this app has hit that exact bug more than once,
  // and it's what made a paycheck due tomorrow render as "today" here.
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  // "Today" is the exception — it's a real instant (`new Date()`), not a
  // `@db.Date`, and this is a `"use client"` component, so the viewer's
  // sense of what day it is *is* their local calendar day. Reading it with
  // UTC getters made the reverse off-by-one: a viewer west of UTC in their
  // own evening (America/Denver, ~6pm+) had "today" jump a day ahead,
  // ringing tomorrow's cell (real report, 2026-08-26: Wednesday evening
  // highlighting Thursday). Near a month boundary local-today can fall
  // outside the rendered UTC month — then nothing rings, which is fine.
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  // Fixed-position placement off the day cell's rect, clamped so the popover
  // never leaves the viewport horizontally, and opened toward whichever side
  // of the cell has more room. Deliberately NO height cap / scroll container:
  // every attempt to cap-and-scroll this thing clipped a few px off the first
  // or last row's status icon (a scroll container clips to its padding box;
  // a mis-sized cap made content == container; a fixed `100dvh` cap ignored
  // the anchor offset and the viewport clipped the ends) — three rounds of
  // that (household reports, 2026-09-08). A day realistically has a handful
  // of payments, so the popover is short; let it size to its content. If a
  // pathological day ever overflows the viewport the popover dismisses on
  // scroll anyway.
  function popoverStyle(rect: DOMRect): CSSProperties {
    const left = Math.round(
      Math.min(
        Math.max(rect.left + rect.width / 2 - POPOVER_WIDTH / 2, VIEWPORT_MARGIN),
        window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN,
      ),
    );
    const GAP = 4;
    const roomBelow = window.innerHeight - rect.bottom;
    const roomAbove = rect.top;
    const below = roomBelow >= roomAbove;
    return {
      position: "fixed",
      left,
      width: POPOVER_WIDTH,
      ...(below
        ? { top: Math.round(rect.bottom + GAP) }
        : { bottom: Math.round(window.innerHeight - rect.top + GAP) }),
    };
  }

  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className={fillHeight ? "flex h-full flex-col" : undefined}>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-gray-500 dark:text-neutral-400">
        {WEEKDAY_LABELS.map((label, i) => (
          <div key={i}>{label}</div>
        ))}
      </div>
      <div
        className={`mt-1 grid grid-cols-7 gap-1${
          fillHeight ? " flex-1 [grid-auto-rows:1fr]" : ""
        }`}
      >
        {cells.map((day, i) => {
          if (day === null) return <div key={i} />;
          const events = eventsByDay.get(day) ?? [];
          const hasEvents = events.length > 0;
          const hasPaid = events.some((e) => e.status === "paid");
          // Something on this day has posted, but something else here hasn't
          // yet — a real report (2026-09-10): a bill paid the same day another
          // bill is still due read as a fully-green "done" cell. A partial day
          // gets its own amber so it's not mistaken for settled; once the
          // straggler posts (moving to its real day) or comes due elsewhere,
          // the cell resolves to green or stays blue on its own.
          const hasPending = events.some((e) => e.status === "due" || e.status === "expected");
          const partiallyPaid = hasPaid && hasPending;
          // A skipped bill doesn't count toward paid or pending — nothing's
          // actually owed either way — but still deserves its own distinct
          // (muted, not plain-empty) cell when it's the only thing on the
          // day, so a household can still spot and open it (household
          // request, 2026-09-14).
          const hasSkippedOnly = !hasPaid && !hasPending && events.some((e) => e.status === "skipped");
          const hasPayoff = events.some((e) => e.isPayoff);
          // A projected payoff-plan extra payment lands here — badged with a
          // circle-plus, stacked below the payoff star when both are present.
          const hasExtra = events.some((e) => e.status === "expected" || e.isExtraPayment);
          const isToday = isCurrentMonth && today.getDate() === day;
          const isOpen = openDay === day;
          return (
            <div key={i} className="relative">
              <button
                type="button"
                disabled={!hasEvents}
                onClick={(e) => (isOpen ? close() : hasEvents && open(day, e.currentTarget))}
                onMouseEnter={(e) => hasEvents && open(day, e.currentTarget)}
                onMouseLeave={close}
                aria-label={
                  hasEvents
                    ? `${day} — ${events.length} payment${events.length === 1 ? "" : "s"}${partiallyPaid ? ", some paid, some still due" : ""}${hasSkippedOnly ? ", skipped this cycle" : ""}${hasExtra ? ", includes an extra payment" : ""}${hasPayoff ? ", pays off a debt" : ""}`
                    : String(day)
                }
                className={`relative flex ${fillHeight ? "h-full min-h-8 lg:min-h-9" : "h-9"} w-full items-center justify-center rounded-lg text-xs transition-colors disabled:cursor-default ${
                  hasEvents
                    ? partiallyPaid
                      ? "bg-amber-100 dark:bg-amber-950/50 font-medium text-amber-800 dark:text-amber-300"
                      : hasPaid
                        ? "bg-emerald-100 dark:bg-emerald-950/50 font-medium text-emerald-800 dark:text-emerald-300"
                        : hasSkippedOnly
                          ? "bg-neutral-100 dark:bg-neutral-800 font-medium text-neutral-500 dark:text-neutral-400"
                          : "bg-blue-100 dark:bg-blue-950/50 font-medium text-blue-900 dark:text-blue-300"
                    : "text-neutral-400 dark:text-neutral-600"
                } ${isToday ? "ring-1 ring-inset ring-blue-900 dark:ring-amber-400" : ""}`}
              >
                {day}
                {(hasPayoff || hasExtra) && (
                  <span className="absolute -right-1 -top-1 flex flex-col items-center gap-0.5">
                    {hasPayoff && (
                      <Star size={11} className="fill-emerald-400 text-emerald-500" />
                    )}
                    {hasExtra && (
                      <BanknoteArrowUp
                        size={12}
                        className="fill-[var(--background)] text-emerald-600 dark:text-emerald-400"
                      />
                    )}
                  </span>
                )}
              </button>
              {isOpen && hasEvents && anchorRect &&
                createPortal(
                  <div
                    role="tooltip"
                    style={popoverStyle(anchorRect)}
                    className="z-[var(--z-overlay)] rounded-lg border border-blue-100 dark:border-neutral-700 bg-white dark:bg-neutral-900 p-2 shadow-lg"
                  >
                  <ul className="flex flex-col gap-1.5 text-xs">
                    {events.map((e, j) => (
                      <li key={j} className="flex flex-col gap-0.5">
                        {/* One line: name + amount (+ payoff star). No "(Due)" /
                            "(Expected)" text and no extra-payment icon here —
                            an extra payment is marked by its own byline(s)
                            below (2026-09-01); a plain line is just that day's
                            obligation. Friendly account names (short) keep
                            this from wrapping the way the raw Debt.name did. */}
                        <div className="flex items-center justify-between gap-2">
                          {/* Icons are plain `shrink-0` flex siblings, vertically
                              centered by the row's `items-center` — the same
                              pattern the "This Week's Bills" card uses. Earlier
                              versions wrapped each in a fixed-height span / a
                              `mt-0.5` nudge and chased phantom clipping for it
                              (2026-09-08); this is simpler and can't clip. */}
                          <span className="flex min-w-0 items-center gap-1 text-neutral-700 dark:text-neutral-300">
                            {e.status === "paid" &&
                              (e.pendingConfirmation ? (
                                <span title="Balance updated — payment details pending" className="flex shrink-0">
                                  <Clock size={11} className="text-gray-500 dark:text-neutral-400" />
                                </span>
                              ) : (
                                <span title="Paid" className="flex shrink-0">
                                  <CheckCircle2 size={11} className="text-emerald-600 dark:text-emerald-400" />
                                </span>
                              ))}
                            {e.status === "skipped" && (
                              <span title="Skipped This Cycle" className="flex shrink-0">
                                <CircleSlash size={11} className="text-neutral-400 dark:text-neutral-600" />
                              </span>
                            )}
                            {e.kind === "bill" && (
                              <span title="Bill or Subscription" className="flex shrink-0">
                                <Receipt size={11} className="text-blue-700 dark:text-blue-300" />
                              </span>
                            )}
                            <span className="min-w-0 truncate">{e.debtName}</span>
                            {e.inPlan && (
                              <span title="Included in the Debt Payoff Plan" className="flex shrink-0">
                                <Target size={11} className="text-emerald-600 dark:text-emerald-400" />
                              </span>
                            )}
                            {e.status === "paid" && e.isExtraPayment && (
                              <span title="Extra Payoff-Plan Payment" className="flex shrink-0">
                                <BanknoteArrowUp size={11} className="text-emerald-600 dark:text-emerald-400" />
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {e.amountCents !== undefined && (
                              <span
                                className={`font-medium ${
                                  e.status === "skipped"
                                    ? "text-neutral-400 line-through opacity-70 dark:text-neutral-600"
                                    : "text-neutral-900 dark:text-neutral-100"
                                }`}
                              >
                                {formatCents(e.amountCents)}
                              </span>
                            )}
                            {e.isPayoff && (
                              <span title="Pays Off This Debt">
                                <Star size={12} className="fill-emerald-400 text-emerald-500" />
                              </span>
                            )}
                          </span>
                        </div>
                        {/* One byline per source for every extra payment,
                            each with the banknote-arrow-up icon — same read as
                            the dashboard's "This Week's Bills" (household
                            request, 2026-09-01). This row's own extra amount
                            is split base-first, then each rolled-in freed
                            minimum in payoff order (see PoolBreakdown). */}
                        {e.status === "expected" &&
                          (e.poolBreakdown?.parts ?? [{ kind: "base" as const, amountCents: e.amountCents ?? 0 }])
                            .filter((p) => p.amountCents > 0)
                            .map((p, k) => (
                              <p
                                key={k}
                                className="flex items-center gap-1 pl-3 text-[10px] text-emerald-700 dark:text-emerald-400"
                              >
                                <BanknoteArrowUp size={11} className="shrink-0" />
                                {formatCents(p.amountCents)} {p.kind === "base" ? "Extra" : `Rolled From ${p.name}`}
                              </p>
                            ))}
                        {e.status === "paid" && e.pendingConfirmation && (
                          <p className="flex items-center gap-1 pl-3 text-[10px] text-gray-500 dark:text-neutral-400">
                            <Clock size={11} className="shrink-0" />
                            Payment Details Pending
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                  </div>,
                  document.body,
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
