// The bill-notice half of the email pipeline (see src/lib/receipt-sync.ts,
// which fetches + AI-parses the same mail this reads from — BillNoticeEmail
// rows are written there, in processBatch, right alongside Receipt rows).
//
//   matchBillNoticeAmounts — link parsed notices to a RecurringBill/Debt by
//                            biller name, and flag an amount that doesn't
//                            match what's tracked (see bill-notice-match.ts)
//   purgeStaleBillNotices  — drop the transient bookkeeping once it's spent
//
// Every email-derived amount change is confirmation-gated, never auto-
// applied — see BillAmountReview / DebtAmountReview(source: EMAIL). Matching
// only ever produces MATCH / AMBIGUOUS / UNMATCHED; a low-confidence guess is
// never treated as a written amount, only as a question to ask.

import type { BillNoticeEmail } from "@prisma/client";
import { db } from "@/lib/db";
import { pickBillNoticeMatch, last4sIn } from "@/lib/bill-notice-match";
import { debtDisplayName } from "@/lib/debt-payments";
import { sendPushToHouseholdForType } from "@/lib/push";
import { formatCents } from "@/lib/money";
import { formatDate, ordinal, todayAsUTCDate } from "@/lib/date";
import {
  billNoticeDueDateUpdate,
  dueDayDiffers,
  debtDueDateDismissKey,
  DEBT_DUE_DATE_DISMISS_KIND,
} from "@/lib/bill-notice-due-date";

const UNMATCHED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Match

export async function matchBillNoticeAmounts(householdId: string): Promise<void> {
  // Oldest first, so when one sync picks up several statements for the same
  // debt, the newest is the one its review ends up holding.
  const notices = await db.billNoticeEmail.findMany({
    where: { householdId, status: { in: ["PENDING", "AMBIGUOUS", "UNMATCHED"] } },
    orderBy: { receivedAt: "asc" },
  });
  if (notices.length === 0) return;

  const [bills, debts] = await Promise.all([
    db.recurringBill.findMany({ where: { householdId, active: true }, select: { id: true, name: true, amountCents: true } }),
    db.debt.findMany({
      where: { householdId, hiddenAt: null, debtPayment: { isNot: null } },
      select: {
        id: true,
        name: true,
        account: { select: { displayName: true, name: true, orgName: true } },
        debtPayment: { select: { amountCents: true } },
      },
    }),
  ]);
  // A card's notice comes from its issuer ("Chase") and quotes the account's
  // last 4 — so each debt also answers to its account's institution and raw
  // name, and to any 4-digit ending in its names (see BillNoticeMatchCandidate).
  const debtCandidates = debts.map((d) => ({
    id: d.id,
    name: debtDisplayName(d),
    amountCents: d.debtPayment!.amountCents,
    aliases: [d.account?.orgName, d.account?.name].filter((a): a is string => !!a),
    last4s: last4sIn(d.name, d.account?.name, d.account?.displayName),
  }));

  for (const notice of notices) {
    const result = pickBillNoticeMatch(
      notice.billerName,
      notice.amountDueCents,
      bills,
      debtCandidates,
      notice.accountLast4,
    );
    if (result.outcome === "UNMATCHED" || result.outcome === "AMBIGUOUS") {
      if (notice.status !== result.outcome) {
        await db.billNoticeEmail.update({ where: { id: notice.id }, data: { status: result.outcome } });
      }
      continue;
    }
    await applyBillNoticeMatch(notice, result);
  }
}

// Applies a resolved match (automatic or a human's manual pick in the
// /settings/email linker) — compares the notice's stated amount against
// what's tracked and either closes the question out (NO_CHANGE) or opens/
// refreshes a review. Shared by matchBillNoticeAmounts above and
// linkBillNoticeToBill/linkBillNoticeToDebt (src/app/settings/email/actions.ts)
// so an automatic match and a manual link behave identically.
export async function applyBillNoticeMatch(
  notice: BillNoticeEmail,
  target: { type: "BILL"; id: string } | { type: "DEBT"; id: string },
): Promise<void> {
  if (target.type === "BILL") {
    const bill = await db.recurringBill.findUnique({
      where: { id: target.id },
      select: { id: true, name: true, amountCents: true, nextDueDate: true },
    });
    if (!bill) return;

    // A bill's due date never asks — see bill-notice-due-date.ts. Applied
    // whatever the amount turns out to be.
    const quietDueDate = billNoticeDueDateUpdate(notice.dueDate, bill.nextDueDate, todayAsUTCDate());
    if (quietDueDate) {
      await db.recurringBill.update({ where: { id: bill.id }, data: { nextDueDate: quietDueDate } });
    }

    if (notice.amountDueCents === bill.amountCents) {
      await db.billNoticeEmail.update({
        where: { id: notice.id },
        data: { status: "NO_CHANGE", targetType: "BILL", billId: bill.id },
      });
      return;
    }

    const existing = await db.billAmountReview.findFirst({ where: { billId: bill.id } });
    if (existing) {
      if (existing.billNoticeEmailId !== notice.id) {
        await db.billAmountReview.update({
          where: { id: existing.id },
          data: {
            billNoticeEmailId: notice.id,
            observedAmountCents: notice.amountDueCents,
            expectedAmountCents: bill.amountCents,
            dueDate: notice.dueDate,
            accountLast4: notice.accountLast4,
          },
        });
      }
    } else {
      await db.billAmountReview.create({
        data: {
          householdId: notice.householdId,
          billId: bill.id,
          billNoticeEmailId: notice.id,
          observedAmountCents: notice.amountDueCents,
          expectedAmountCents: bill.amountCents,
          dueDate: notice.dueDate,
          accountLast4: notice.accountLast4,
        },
      });
      await sendPushToHouseholdForType(notice.householdId, "BILL_AMOUNT_REVIEW", {
        title: "Did your bill's amount change?",
        body: `${bill.name}: its latest bill says ${formatCents(notice.amountDueCents)} (was ${formatCents(bill.amountCents)}).`,
        url: "/bills",
      });
    }

    await db.billNoticeEmail.update({
      where: { id: notice.id },
      data: { status: "REVIEW_CREATED", targetType: "BILL", billId: bill.id },
    });
    return;
  }

  const debt = await db.debt.findUnique({
    where: { id: target.id },
    select: {
      id: true,
      name: true,
      debtType: true,
      account: { select: { displayName: true } },
      debtPayment: { select: { id: true, amountCents: true, amountDueCents: true, nextDueDate: true, cadence: true } },
    },
  });
  if (!debt?.debtPayment) return;
  const dp = debt.debtPayment;

  await reviewDebtNoticeDueDate(notice, debt, dp);

  if (notice.amountDueCents === dp.amountCents) {
    await db.billNoticeEmail.update({
      where: { id: notice.id },
      data: { status: "NO_CHANGE", targetType: "DEBT", debtId: debt.id },
    });
    return;
  }

  const existing = await db.debtAmountReview.findFirst({ where: { debtPaymentId: dp.id } });
  if (existing?.source === "BANK_SYNC") {
    // A bank-observed drift question is already open for this debt — leave
    // the notice PENDING to retry next sync rather than compete with it.
    return;
  }
  if (existing) {
    if (existing.billNoticeEmailId !== notice.id) {
      await db.debtAmountReview.update({
        where: { id: existing.id },
        data: {
          billNoticeEmailId: notice.id,
          observedAmountCents: notice.amountDueCents,
          expectedAmountCents: dp.amountCents,
          expectedAmountDueCents: dp.amountDueCents,
          dueDate: notice.dueDate,
          accountLast4: notice.accountLast4,
        },
      });
    }
  } else {
    await db.debtAmountReview.create({
      data: {
        householdId: notice.householdId,
        debtPaymentId: dp.id,
        source: "EMAIL",
        billNoticeEmailId: notice.id,
        observedAmountCents: notice.amountDueCents,
        expectedAmountCents: dp.amountCents,
        expectedAmountDueCents: dp.amountDueCents,
        dueDate: notice.dueDate,
        accountLast4: notice.accountLast4,
        cycleAlreadyAdvanced: true,
      },
    });
    await sendPushToHouseholdForType(notice.householdId, "DEBT_AMOUNT_REVIEW", {
      title: "Did your minimum payment change?",
      body: `${debtDisplayName(debt)}: its latest bill says ${formatCents(notice.amountDueCents)} is now due (was ${formatCents(dp.amountCents)}).`,
      url: "/",
    });
  }

  await db.billNoticeEmail.update({
    where: { id: notice.id },
    data: { status: "REVIEW_CREATED", targetType: "DEBT", debtId: debt.id },
  });
}

// Opens (or refreshes) a "did the due date change?" question when a card/
// loan statement names a different day than the one tracked. MONTHLY
// REVOLVING trackers only: a BNPL plan bills every week or two, so its
// day-of-month means nothing. Skipped once the household has declined that
// same day for this debt (debtDueDateDismissKey).
async function reviewDebtNoticeDueDate(
  notice: BillNoticeEmail,
  debt: { name: string; debtType: string; account: { displayName: string | null } | null },
  dp: { id: string; nextDueDate: Date; cadence: string },
): Promise<void> {
  if (!notice.dueDate || debt.debtType !== "REVOLVING" || dp.cadence !== "MONTHLY") return;

  const existing = await db.debtDueDateReview.findUnique({ where: { debtPaymentId: dp.id } });
  if (!dueDayDiffers(notice.dueDate, dp.nextDueDate)) {
    // A newer statement agrees with what's tracked — an open question from
    // an older one is moot.
    if (existing) await db.debtDueDateReview.delete({ where: { id: existing.id } });
    return;
  }
  const declined = await db.suggestionDismissal.findUnique({
    where: {
      householdId_kind_key: {
        householdId: notice.householdId,
        kind: DEBT_DUE_DATE_DISMISS_KIND,
        key: debtDueDateDismissKey(dp.id, notice.dueDate),
      },
    },
  });
  if (declined) return;

  const data = {
    observedDueDate: notice.dueDate,
    statementDate: todayAsUTCDate(notice.receivedAt),
    expectedDueDate: dp.nextDueDate,
    accountLast4: notice.accountLast4,
  };
  if (existing) {
    await db.debtDueDateReview.update({ where: { id: existing.id }, data });
    return;
  }
  await db.debtDueDateReview.create({ data: { householdId: notice.householdId, debtPaymentId: dp.id, ...data } });
  await sendPushToHouseholdForType(notice.householdId, "DEBT_AMOUNT_REVIEW", {
    title: "Did your due date change?",
    body: `${debtDisplayName(debt)}: its latest statement says it's due ${formatDate(notice.dueDate, {
      month: "short",
      day: "numeric",
    })} (Flow has the ${ordinal(dp.nextDueDate.getUTCDate())}).`,
    url: "/",
  });
}

export async function dismissBillNoticeEmail(noticeId: string): Promise<void> {
  await db.billNoticeEmail.update({ where: { id: noticeId }, data: { status: "DISMISSED" } });
}

// ---------------------------------------------------------------------------
// Purge

export async function purgeStaleBillNotices(householdId: string): Promise<void> {
  const cutoff = new Date(Date.now() - UNMATCHED_TTL_MS);
  await db.billNoticeEmail.deleteMany({
    where: {
      householdId,
      OR: [
        { status: { in: ["DISMISSED", "NO_CHANGE"] } },
        // A review it fed has since been resolved (confirmed/declined) —
        // nothing left pointing at it.
        { status: "REVIEW_CREATED", amountReview: null, debtAmountReview: null },
        { status: { in: ["PENDING", "AMBIGUOUS", "UNMATCHED"] }, createdAt: { lt: cutoff } },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// /settings/email "Unmatched Bill Notices" linker

export type UnmatchedBillNotice = {
  id: string;
  billerName: string;
  amountDueCents: number;
  dueDate: Date | null;
  receivedAt: Date;
};

// Scoped to one member's own connected mailbox(es), same as /settings/email's
// existing receipt-linker query (unmatchedAll in that page) — this page is
// specifically about "my mailbox connections," not a household-wide view.
// `inboxScope`: whose inboxes — see emailInboxScope (access-rules.ts).
export async function getUnmatchedBillNotices(
  inboxScope: { householdId: string } | { userId: string },
): Promise<UnmatchedBillNotice[]> {
  const notices = await db.billNoticeEmail.findMany({
    where: { emailConnection: inboxScope, status: { in: ["AMBIGUOUS", "UNMATCHED"] } },
    orderBy: { receivedAt: "desc" },
  });
  return notices.map((n) => ({
    id: n.id,
    billerName: n.billerName,
    amountDueCents: n.amountDueCents,
    dueDate: n.dueDate,
    receivedAt: n.receivedAt,
  }));
}
