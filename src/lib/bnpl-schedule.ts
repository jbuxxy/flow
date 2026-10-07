// Every installment of a BNPL plan, 1…N, for the expanded plan card on
// /settings/accounts — already-paid ones (with the real matched charge's date
// and amount when there is one), the next one due, and the rest projected
// forward from DebtPayment.nextDueDate one cadence step at a time.
//
// Pure + client-safe (only addCadenceISO, itself dependency-free) so the
// schedule is unit-testable without a DB. "Paid" is decided by the plan's own
// installment counters (installmentsTotal − installmentsRemaining), not by how
// many charges happened to match — a plan entered mid-way ("next payment 3 of
// 4") has two paid installments with no transaction behind them at all.
import type { BillCadence } from "@prisma/client";
import { addCadenceISO } from "@/lib/cadence-label";

export type BnplScheduleStatus = "PAID" | "NEXT" | "UPCOMING";

export type BnplScheduleRow = {
  number: number;
  // ISO "YYYY-MM-DD"; null for a paid installment with no matched charge.
  date: string | null;
  amountCents: number;
  status: BnplScheduleStatus;
};

export function buildBnplSchedule(opts: {
  installmentsTotal: number | null;
  installmentsRemaining: number | null;
  paymentCents: number;
  balanceCents: number;
  nextDueDate: string | null; // ISO date of the next unpaid installment
  cadence: BillCadence;
  // The plan's matched payments, oldest first.
  paidPayments: { date: string; amountCents: number }[];
}): BnplScheduleRow[] {
  const total = opts.installmentsTotal;
  if (total == null || total <= 0) return [];
  const remaining = Math.min(total, Math.max(0, opts.balanceCents === 0 ? 0 : (opts.installmentsRemaining ?? total)));
  const paidCount = total - remaining;
  const rows: BnplScheduleRow[] = [];

  // The newest matches belong to the newest paid installments — an older
  // installment paid before tracking started is the one missing a charge.
  const matched = opts.paidPayments.slice(-paidCount);
  const unmatchedLead = paidCount - matched.length;
  for (let i = 0; i < paidCount; i++) {
    const m = i >= unmatchedLead ? matched[i - unmatchedLead] : undefined;
    rows.push({
      number: i + 1,
      date: m ? m.date.slice(0, 10) : null,
      amountCents: m ? m.amountCents : opts.paymentCents,
      status: "PAID",
    });
  }

  if (remaining === 0 || !opts.nextDueDate) return rows;

  // Last installment absorbs rounding (a $100 plan in 3 → 33.33/33.33/33.34)
  // when the balance says so — but only within reason, so a stale balance
  // never projects a wildly off final payment.
  const tail = opts.balanceCents - opts.paymentCents * (remaining - 1);
  const lastAmount = tail > 0 && tail <= opts.paymentCents * 1.5 ? tail : opts.paymentCents;

  let date = opts.nextDueDate.slice(0, 10);
  for (let i = 0; i < remaining; i++) {
    rows.push({
      number: paidCount + i + 1,
      date,
      amountCents: i === remaining - 1 ? lastAmount : opts.paymentCents,
      status: i === 0 ? "NEXT" : "UPCOMING",
    });
    date = addCadenceISO(date, opts.cadence);
  }
  return rows;
}
