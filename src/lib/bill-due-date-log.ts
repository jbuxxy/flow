import { db } from "@/lib/db";

// Every write of RecurringBill.nextDueDate records where it came from
// (BillDueDateChange) — 2026-10-24: a Verizon bill's due date jumped a
// month ahead with no payment and nothing could say which path did it.
// Returned as a PrismaPromise so callers can put it in the same
// db.$transaction as the update; null when the date didn't actually move.
export type BillDueDateSource =
  | "EDIT_FORM" // updateBill (bills/actions.ts)
  | "SKIP" // skipBillCycle
  | "UNSKIP" // unskipBillCycle
  | "MANUAL_LINK" // attachTransactionAsBillPayment (recurring-bills.ts)
  | "PAYMENT_MATCH" // matchBillPayments, a cycle's payment found
  | "CATCH_UP" // matchBillPayments' fast-forward past lastPaidDate
  | "BILL_EMAIL"; // applyBillNoticeMatch (bill-notice-sync.ts)

export function logBillDueDateChange(
  bill: { id: string; householdId: string },
  fromDate: Date,
  toDate: Date,
  source: BillDueDateSource,
  // The record that caused it, when there is one: a transaction id or a
  // BillNoticeEmail id.
  detail?: string | null,
) {
  if (fromDate.getTime() === toDate.getTime()) return null;
  return db.billDueDateChange.create({
    data: { householdId: bill.householdId, billId: bill.id, fromDate, toDate, source, detail: detail ?? null },
  });
}
