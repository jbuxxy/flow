import { amountToleranceCents } from "@/lib/amount-tolerance";

// Pure — no `db`. Decides how a debt's "This Month" ledger presents each
// minimum-payment slot when a payment was made *ahead of* it that's bigger
// than the minimum (2026-09-19: a $177 payment on Sep 18 against an $84
// minimum due Sep 27, made to cover a purchase).
//
// buildCycleSlots pairs payments to slots positionally, so that early $177
// consumes the Sep 27 slot and the ledger used to show only "✓ Sep 18
// $177" — the still-scheduled $84 vanished. Nothing about the accounting is
// wrong (the cycle IS satisfied: amountDueCents stays 0, nothing rolls into
// next month, projections don't re-deduct it), so this changes presentation
// only: the big payment reads as a plain payment and the slot stays listed
// as a "covered" line the household can skip. An unsatisfied slot is never
// "covered" — it's an ordinary open line with no skip, and rolls forward
// exactly as before.
//
// A payment counts as an overpayment ahead of its slot only when it landed
// before the slot's due date AND exceeded the minimum by more than
// amountToleranceCents (the same tolerance the sync uses to call a payment
// "the minimum"). A payment of about the minimum, or any payment on/after the
// due date, is the slot's own payment and reads as before.

type LedgerPayment = { id: string; amountCents: number; occurredOn: Date };

export type MinimumLedgerEntry =
  // A real payment row (the slot's own payment, an overpayment that covered
  // it, or a later payment that ticked a covered slot off).
  | { kind: "payment"; payment: LedgerPayment }
  // A slot with no payment — an ordinary open minimum line.
  | { kind: "open"; date: Date }
  // A slot whose minimum an earlier, bigger payment already satisfied. The
  // caller renders it open + skippable (or struck + Undo when `skipped`).
  | { kind: "covered"; date: Date; skipped: boolean };

const CLAIM_LEAD_DAYS = 3;
const DAY_MS = 86_400_000;

export function resolveMinimumLedger(opts: {
  slots: { date: Date; payment: LedgerPayment | null }[];
  // Real payments beyond the slot count (CycleMinimum.extraPayments).
  extraPayments: LedgerPayment[];
  minimumCents: number;
  // ISO (YYYY-MM-DD) due dates the household has skipped.
  skippedDates: ReadonlySet<string>;
}): { entries: MinimumLedgerEntry[]; extraPayments: LedgerPayment[] } {
  const { slots, minimumCents, skippedDates } = opts;
  const remainingExtras = [...opts.extraPayments].sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());
  const entries: MinimumLedgerEntry[] = [];
  const tolerance = amountToleranceCents(minimumCents);

  for (const slot of slots) {
    const p = slot.payment;
    if (!p) {
      entries.push({ kind: "open", date: slot.date });
      continue;
    }
    entries.push({ kind: "payment", payment: p });

    const paidAheadAndOver =
      minimumCents > 0 && p.occurredOn.getTime() < slot.date.getTime() && p.amountCents > minimumCents + tolerance;
    if (!paidAheadAndOver) continue;

    // The regular minimum arriving around its due date ticks the covered
    // line off — that payment IS this slot's payment. Only a payment near
    // (or above) the minimum, on/just before the due date, qualifies, so an
    // unrelated small extra payment mid-month doesn't.
    const claimIdx = remainingExtras.findIndex(
      (e) =>
        e.occurredOn.getTime() >= slot.date.getTime() - CLAIM_LEAD_DAYS * DAY_MS &&
        e.amountCents >= minimumCents - tolerance,
    );
    if (claimIdx >= 0) {
      entries.push({ kind: "payment", payment: remainingExtras[claimIdx] });
      remainingExtras.splice(claimIdx, 1);
      continue;
    }
    entries.push({ kind: "covered", date: slot.date, skipped: skippedDates.has(slot.date.toISOString().slice(0, 10)) });
  }
  return { entries, extraPayments: remainingExtras };
}

// The minimum the "covered" logic should be sized against, or 0 to disable it:
// paid off, or the tracker still owes money on this month's due date
// (arrears) — an unsatisfied minimum is never "covered", never skippable, and
// rolls forward as always. After the due date passes nextDueDate moves to next
// month, so a leftover covered line from this month isn't gated by next
// month's fresh amountDue. Shared by DebtRow and every calendar so they can't
// disagree about when a covered minimum exists.
export function ledgerMinimumCents(opts: {
  paidOff: boolean;
  nextDueThisMonth: boolean;
  amountDueCents: number;
  minimumCents: number;
}): number {
  return opts.paidOff || (opts.nextDueThisMonth && opts.amountDueCents > 0) ? 0 : opts.minimumCents;
}

// Every covered-minimum slot date this month (see resolveMinimumLedger), for
// the calendars: a bigger early payment satisfied the cycle, but the regular
// minimum stays on the calendar unless the household skipped it (2026-09-20).
// Skipped ones are omitted, same as a skipped payoff-plan extra.
export function coveredMinimumDates(opts: {
  slots: { date: Date; payment: LedgerPayment | null }[];
  extraPayments: LedgerPayment[];
  minimumCents: number;
  skippedDates: ReadonlySet<string>;
}): Date[] {
  return resolveMinimumLedger(opts)
    .entries.flatMap((e) => (e.kind === "covered" && !e.skipped ? [e.date] : []));
}
