"use server";

import { CLEARED_CLASSIFICATION } from "@/lib/classification-reset";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireOwner, belongsToHousehold } from "@/lib/access";
import { db } from "@/lib/db";
import { parseDollarsToCents, parseOptionalToleranceCents, parsePercentToBasisPoints } from "@/lib/money";
import { reassignTransactionsForDebt } from "@/lib/debt-reassign";
import { debtBalanceUpdate } from "@/lib/debt-payoff";
import { nextBillDueDate } from "@/lib/recurring-bills";
import { upsertMerchantRule } from "@/lib/merchant-rules";
import { nextOccurrenceOfDay, currentMonthOccurrenceOfDay, todayAsUTCDate, parseDueDay } from "@/lib/date";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { releaseBnplCluster, allBnplKeywords, resolveBnplKeyword } from "@/lib/bnpl-detect";
import {
  defaultDebtPaymentBucketId,
  backfillDebtPaymentHistory,
  filterDebtPaymentTwins,
  unhideDebtPaymentIfBalanceReturned,
  matchInstallmentPayments,
  minPaymentDismissKey,
  debtSetupReason,
  debtSetupDismissKey,
  shouldRefreshAmountDueOnEmailConfirm,
} from "@/lib/debt-payments";
import { revalidateHousehold } from "@/lib/revalidate";

const cadenceEnum = z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "ANNUAL"]);

// A "YYYY-MM-DD" first-due-date from the add-debt form -> the tracker's
// nextDueDate. Whatever the household picked IS the first cycle (see
// RevolvingDebtFields) — but if they picked a date already in the past,
// roll forward to the next occurrence of that day-of-month so the tracker
// starts on a real upcoming date rather than immediately overdue.
function parseFirstDueDate(dueDate: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const picked = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(picked.getTime())) return null;
  // Start of *today* in the household's local calendar, as UTC midnight — a
  // bare `new Date().getUTC*` is tomorrow's date after ~6pm here
  // (TZ=America/Denver), which would treat a first-due-date the household
  // picked as "today" as already past and roll it a whole month forward.
  const startOfToday = todayAsUTCDate();
  return picked >= startOfToday ? picked : nextOccurrenceOfDay(picked.getUTCDate());
}

const baseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  debtType: z.enum(["REVOLVING", "INSTALLMENT"]),
  apr: z.string(), // percent, e.g. "24.49" or "0"
});

const revolvingSchema = baseSchema.extend({
  balance: z.string(),
  minPayment: z.string(),
  // Optional — a household adding a debt manually may not know/want to set
  // a due date yet. When given, upsertDebtPayment creates/updates the
  // linked DebtPayment tracker right here instead of requiring a separate
  // suggestion-accept or "track as a bill" step. `dueDate` is the full
  // first-due-date the add form now asks for (see parseFirstDueDate);
  // `dueDay` is the older bare day-of-month, still accepted for any caller
  // that sends it.
  dueDate: z.string().optional(),
  dueDay: z.string().optional(),
  // CARD vs LOAN — see DebtKind's doc comment in schema.prisma. Default
  // guards a missing field the same way the DB column's own default does;
  // AddDebtForm always sends one in practice.
  kind: z.enum(["CARD", "LOAN"]).default("CARD"),
});

const installmentSchema = baseSchema.extend({
  paymentAmount: z.string(),
  totalPayments: z.coerce.number().int().min(1).max(600),
  // cadence/purchaseDate required (2026-08-16) — the matching floor
  // matchInstallmentPayments (src/lib/debt-payments.ts) needs to know where
  // to start looking, and how often to expect a payment, right from
  // creation; unlike REVOLVING's due date this was never optional for BNPL
  // to begin with. No currentPayment here (2026-08-16, dropped) — a brand
  // new plan starts assuming nothing's matched yet; upsertInstallmentDebtPayment's
  // synchronous matchInstallmentPayments sweep immediately searches forward
  // from purchaseDate and corrects installmentsRemaining/nextDueDate from
  // real transaction history instead of asking the household to self-report
  // a payment count they'd have to go count by hand.
  cadence: cadenceEnum,
  purchaseDate: z.string().min(1),
  // Optional — when the first installment isn't due at purchase (Klarna
  // monthly financing / Affirm monthly both bill their first payment ~1
  // cycle out, not on the checkout day). Left blank, the first payment is
  // assumed to fall on the purchase date itself (Pay-in-4 style). Drives
  // DebtPayment.nextDueDate; purchaseDate stays the backfill-search anchor.
  firstPaymentDate: z.string().optional(),
  tolerance: z.string().optional(),
  // Optional — falls back to defaultDebtPaymentBucketId when left blank
  // (see upsertInstallmentDebtPayment), same as every other bucket picker
  // that pre-fills from it.
  bucketId: z.string().optional(),
  categoryId: z.string().optional(),
  // Optional free-text "what was this actually for" — see Debt.label.
  label: z.string().trim().max(120).optional(),
});

// debtId set on success — lets AddDebtModal (the quick-add-from-a-
// transaction flow, src/app/buckets/[id]/add-debt-modal.tsx) auto-select
// the debt it just created via this same action.
export type DebtFormState = { error?: string; debtId?: string };

// "Payment 3 of 12" -> 10 payments still owed (this one plus the 9 after
// it) -> balance is just that many payments' worth, since BNPL installment
// amounts are fixed by contract, not computed from balance/APR like a
// REVOLVING debt's minimum payment is.
function installmentsRemainingFrom(totalPayments: number, currentPayment: number): number {
  return totalPayments - currentPayment + 1;
}

// Link one transaction to a DebtPayment unless its offsetting card/loan-side
// twin is already linked there (see filterDebtPaymentTwins, debt-payments.ts).
// matchDebtPayments' own twin filter can't see a manual / review-driven link
// coming, so every hand-link path routes through here — linking both legs
// double-counts every reader that sums DebtPayment.payments.
async function linkTxnToDebtPaymentGuarded(transactionId: string, debtPaymentId: string): Promise<void> {
  const [txn, dp] = await Promise.all([
    db.transaction.findUnique({
      where: { id: transactionId },
      select: { id: true, amountCents: true, occurredOn: true, accountId: true },
    }),
    db.debtPayment.findUnique({ where: { id: debtPaymentId }, select: { debt: { select: { accountId: true } } } }),
  ]);
  if (!txn) return;
  const [survivor] = await filterDebtPaymentTwins(debtPaymentId, [txn], dp?.debt.accountId ?? null);
  if (survivor) {
    await db.transaction.update({ where: { id: transactionId }, data: { debtPaymentId } });
  }
}

// Creates or updates a REVOLVING debt's DebtPayment tracker from the Debts
// page (AddDebtForm, DebtRow's terms edit form, UntrackedLiabilityAccounts'
// track form) — the "one place to set a debt's rate/minimum/due date"
// consolidation. Always marks the date locked/confirmed, since it's always
// a human explicitly typing it here (never an app guess). REVOLVING only —
// see upsertInstallmentDebtPayment below for the INSTALLMENT/BNPL
// counterpart, different enough (fixed payment count/cadence, purchase-date
// anchor, no due-date-only shape) to need its own function.
async function upsertDebtPayment(
  householdId: string,
  debtId: string,
  { amountCents, nextDueDate }: { amountCents: number; nextDueDate: Date },
): Promise<void> {
  const existing = await db.debtPayment.findUnique({ where: { debtId } });
  if (existing) {
    await db.debtPayment.update({
      where: { id: existing.id },
      // A human explicitly retyping the minimum here is exactly a
      // settleDebtAmountDue-equivalent confirmation — reset the rolling
      // amount due to match, same as that action, rather than leaving a
      // stale carried-over shortfall standing against a number that just
      // changed underneath it.
      data: { amountCents, amountDueCents: amountCents, nextDueDate, dueDateLocked: true },
    });
  } else {
    const created = await db.debtPayment.create({
      data: {
        householdId,
        debtId,
        amountCents,
        amountDueCents: amountCents,
        cadence: "MONTHLY",
        nextDueDate,
        dueDateLocked: true,
        // Same default the sync-time self-heal applies (debt-payments.ts)
        // — applied here too so it shows up in Bills immediately, not
        // after the next sync.
        bucketId: await defaultDebtPaymentBucketId(householdId),
      },
    });
    await backfillDebtPaymentHistory(householdId, created);
  }
}

// Debt.minPaymentCents mirrors whichever DebtPayment.amountCents a household
// most recently confirmed or a sync most recently observed — two fields
// carrying the same number, kept equal by remembering to write both rather
// than deriving one from the other (a real schema-level fix would need its
// own product decision — see WORKING_ON.md's 2026-09-11 review notes).
// Centralizing this half — the observation-driven direction (a confirmed
// due-date edit, an accepted amount-changed review) — at least makes it
// harder for a future call site on this side to write DebtPayment.amountCents
// without remembering the companion write; the form-driven direction (Debt's
// own edit forms, which set minPaymentCents as one field among several in a
// single larger update) stays as-is.
async function syncDebtMinPaymentCents(debtId: string, amountCents: number): Promise<void> {
  await db.debt.update({ where: { id: debtId }, data: { minPaymentCents: amountCents } });
}

// The INSTALLMENT/BNPL counterpart to upsertDebtPayment — called from
// createDebt (new plan) and updateInstallmentTerms (editing an existing
// one, including a legacy BNPL debt from before this tracker existed
// opting in for the first time). Only ever *sets* purchaseDate, never
// clears it — it's the one-time anchor a plan was created around. `bucketId`
// is whatever the household explicitly picked on the setup/edit form
// (2026-08-16 — every such form now exposes a bucket picker, pre-filled from
// defaultDebtPaymentBucketId); falls back to that same resolver when left
// blank, on both a brand new tracker AND a re-save of an existing one, so
// changing the bucket on an already-tracked plan actually takes. On a brand
// new tracker, starts nextDueDate at purchaseDate itself — matchInstallmentPayments
// corrects it to the real date immediately after, via the household-wide
// sweep this function always triggers, by searching forward from that same
// anchor for already-happened payments.
async function upsertInstallmentDebtPayment(
  householdId: string,
  debtId: string,
  {
    amountCents,
    cadence,
    toleranceCents,
    purchaseDate,
    firstDueDate,
    bucketId,
    categoryId,
  }: {
    amountCents: number;
    cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";
    toleranceCents: number;
    purchaseDate: Date | null;
    // The first installment's due date. When null, the first payment is
    // assumed to fall on purchaseDate itself (Pay-in-4 style).
    firstDueDate: Date | null;
    bucketId: string | null;
    categoryId: string | null;
  },
): Promise<void> {
  if (purchaseDate) {
    await db.debt.update({ where: { id: debtId }, data: { purchaseDate } });
  }
  // The date the plan's first payment is due — the household-entered first
  // payment date, else the purchase date (Pay-in-4).
  const firstPaymentDate = firstDueDate ?? purchaseDate;

  const resolvedBucketId = bucketId ?? (await defaultDebtPaymentBucketId(householdId));
  // A household picking no category for a BNPL/installment plan almost
  // always just means "obviously BNPL" rather than "leave uncategorized" —
  // same auto-apply-and-create-once-on-first-use convention
  // acceptDebtPaymentSuggestion uses for "Card payment" above, so nobody has
  // to discover and create this category by hand before it's useful. Scoped
  // to resolvedBucketId (see the schema comment on BillCategory.bucketId) —
  // both the explicit pick and the auto-created fallback.
  let resolvedCategoryId =
    categoryId && resolvedBucketId
      ? ((await db.billCategory.findFirst({ where: { id: categoryId, householdId, bucketId: resolvedBucketId } }))?.id ?? null)
      : null;
  if (!resolvedCategoryId && resolvedBucketId) {
    const existingBnpl = await db.billCategory.findUnique({
      where: { bucketId_name: { bucketId: resolvedBucketId, name: "BNPL" } },
    });
    resolvedCategoryId = existingBnpl
      ? existingBnpl.id
      : (await db.billCategory.create({ data: { householdId, bucketId: resolvedBucketId, name: "BNPL" } })).id;
  }

  const existing = await db.debtPayment.findUnique({ where: { debtId } });
  if (existing) {
    // Reposition nextDueDate only while the plan hasn't started — no real
    // payment has matched yet (lastPaidDate null). Once installments have
    // landed, matchInstallmentPayments owns nextDueDate (it advances off each
    // actual payment date) and a terms edit must not yank it backward. An
    // un-started plan is exactly the case the household is fixing when they
    // correct the purchase / first-payment date after setup (real report,
    // 2026-09-03: a Klarna plan bought Sep 3 with its first payment Oct 3
    // kept showing on September's Bills because nextDueDate stuck at the
    // purchase date and no edit ever moved it).
    const notStarted = existing.lastPaidDate === null;
    await db.debtPayment.update({
      where: { id: existing.id },
      data: {
        amountCents,
        cadence,
        toleranceCents,
        bucketId: resolvedBucketId,
        categoryId: resolvedCategoryId,
        ...(notStarted && firstPaymentDate
          ? { nextDueDate: firstPaymentDate, dueDateLocked: true }
          : {}),
      },
    });
  } else {
    await db.debtPayment.create({
      data: {
        householdId,
        debtId,
        amountCents,
        // Unused by matchInstallmentPayments (INSTALLMENT/BNPL has no
        // rolling-amount-due concept — fixed payment count/amount by
        // contract, see that function's own comment) — set for schema
        // completeness only.
        amountDueCents: amountCents,
        cadence,
        toleranceCents,
        // The first installment's due date — the entered first-payment date,
        // else the purchase date (Pay-in-4), else today for a legacy plan
        // opting in with neither.
        nextDueDate: firstPaymentDate ?? todayAsUTCDate(),
        // A human just typed the purchase date/cadence right here, same
        // "explicitly typed = confirmed" convention upsertDebtPayment uses
        // above — but only when they actually gave one; editing a legacy
        // plan's payment amount without also supplying a purchase date
        // shouldn't fabricate a confirmed due date out of nothing.
        dueDateLocked: Boolean(firstPaymentDate),
        bucketId: resolvedBucketId,
        categoryId: resolvedCategoryId,
      },
    });
  }

  // Household-wide, not just this one tracker — cheap (bounded by however
  // many INSTALLMENT plans exist) and lets a freshly created/edited plan's
  // real history backfill immediately, same UX backfillDebtPaymentHistory
  // gives REVOLVING above.
  await matchInstallmentPayments(householdId);
}

export async function createDebt(
  _prev: DebtFormState,
  formData: FormData,
): Promise<DebtFormState> {
  const session = await requireOwner();

  const debtType = formData.get("debtType");

  const maxSort = await db.debt.aggregate({
    where: { householdId: session.user.householdId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;
  let createdDebtId: string;

  if (debtType === "INSTALLMENT") {
    const parsed = installmentSchema.safeParse({
      name: formData.get("name"),
      debtType: formData.get("debtType"),
      apr: formData.get("apr"),
      paymentAmount: formData.get("paymentAmount"),
      totalPayments: formData.get("totalPayments"),
      cadence: formData.get("cadence"),
      purchaseDate: formData.get("purchaseDate"),
      firstPaymentDate: formData.get("firstPaymentDate") || undefined,
      tolerance: formData.get("tolerance") || undefined,
      bucketId: formData.get("bucketId") || undefined,
      categoryId: formData.get("categoryId") || undefined,
      label: formData.get("label") || undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
    const paymentCents = parseDollarsToCents(parsed.data.paymentAmount);
    if (aprBasisPoints === null || paymentCents === null || paymentCents === 0) {
      return { error: "Enter valid APR and payment amount." };
    }
    const purchaseDate = new Date(parsed.data.purchaseDate);
    if (Number.isNaN(purchaseDate.getTime())) return { error: "Enter a valid purchase date." };
    let firstDueDate: Date | null = null;
    if (parsed.data.firstPaymentDate) {
      firstDueDate = new Date(parsed.data.firstPaymentDate);
      if (Number.isNaN(firstDueDate.getTime())) return { error: "Enter a valid first payment date." };
    }
    const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
    if (!tolerance.ok) return { error: "Enter a valid tolerance." };

    // Captured now, from the name the household is typing at creation —
    // see Debt.bnplKeyword's schema comment. A plan whose lender isn't a
    // recognized keyword yet locks in later, automatically, the first time
    // backfillBnplKeywords matches it (e.g. once checkForNewBnplLenders
    // teaches the household's AI connection that provider).
    const bnplKeyword = resolveBnplKeyword(
      { name: parsed.data.name },
      await allBnplKeywords(session.user.householdId),
    );

    // A brand new plan hasn't had anything backfilled yet — starts at the
    // full payment count; upsertInstallmentDebtPayment's synchronous
    // matchInstallmentPayments sweep below immediately searches forward from
    // purchaseDate and decrements this to the real, already-happened count.
    const debt = await db.debt.create({
      data: {
        householdId: session.user.householdId,
        name: parsed.data.name,
        debtType: "INSTALLMENT",
        // Always BNPL — ignores any client input, so debtType === INSTALLMENT
        // stays a reliable BNPL proxy everywhere else (see DebtKind's doc
        // comment in schema.prisma).
        kind: "BNPL",
        bnplKeyword: bnplKeyword ?? null,
        aprBasisPoints,
        minPaymentCents: paymentCents,
        balanceCents: paymentCents * parsed.data.totalPayments,
        installmentsTotal: parsed.data.totalPayments,
        installmentsRemaining: parsed.data.totalPayments,
        label: parsed.data.label || null,
        sortOrder,
      },
    });
    // Sets Debt.purchaseDate too — see upsertInstallmentDebtPayment.
    await upsertInstallmentDebtPayment(session.user.householdId, debt.id, {
      amountCents: paymentCents,
      cadence: parsed.data.cadence,
      toleranceCents: tolerance.value ?? 10, // $0.10 default — see the schema comment on DebtPayment
      purchaseDate,
      firstDueDate,
      bucketId: parsed.data.bucketId ?? null,
      categoryId: parsed.data.categoryId ?? null,
    });
    createdDebtId = debt.id;
  } else {
    const parsed = revolvingSchema.safeParse({
      name: formData.get("name"),
      debtType: formData.get("debtType"),
      apr: formData.get("apr"),
      balance: formData.get("balance"),
      minPayment: formData.get("minPayment"),
      dueDate: formData.get("dueDate") || undefined,
      dueDay: formData.get("dueDay") || undefined,
      kind: formData.get("kind") || undefined,
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

    const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
    const balanceCents = parseDollarsToCents(parsed.data.balance);
    const minPaymentCents = parseDollarsToCents(parsed.data.minPayment);
    if (aprBasisPoints === null || balanceCents === null || minPaymentCents === null) {
      return { error: "Enter valid balance, APR, and minimum payment." };
    }

    // Validated before the Debt row exists — an invalid date used to return
    // its error after creating it, leaving an orphan that a corrected
    // resubmit then duplicated (2026-10-08 review).
    let firstDueDate: Date | null = null;
    if (parsed.data.dueDate) {
      firstDueDate = parseFirstDueDate(parsed.data.dueDate);
      if (firstDueDate === null) return { error: "Enter a valid first due date." };
    } else if (parsed.data.dueDay) {
      const day = parseDueDay(parsed.data.dueDay);
      if (day === null) return { error: "Enter a valid due date." };
      firstDueDate = nextOccurrenceOfDay(day);
    }

    const debt = await db.debt.create({
      data: {
        householdId: session.user.householdId,
        name: parsed.data.name,
        debtType: "REVOLVING",
        kind: parsed.data.kind,
        aprBasisPoints,
        balanceCents,
        minPaymentCents,
        sortOrder,
      },
    });
    if (firstDueDate) {
      await upsertDebtPayment(session.user.householdId, debt.id, {
        amountCents: minPaymentCents,
        nextDueDate: firstDueDate,
      });
    }
    createdDebtId = debt.id;
  }

  // Also clears a BNPL suggestion once tracked as an installment debt — that
  // suggestion now renders on /buckets, not /debts (2026-08-16 move), and
  // the dashboard's own AttentionLinkCard reads detectUnlinkedBnpl too.
  revalidateHousehold();
  // AddDebtModal (src/app/buckets/[id]/add-debt-modal.tsx) calls this from
  // /transactions and needs its debt picker (debtOptions,
  // src/app/transactions/page.tsx) to see a debt created here on next load.
  revalidateHousehold();
  return { debtId: createdDebtId };
}

const updateBalanceSchema = z.object({
  debtId: z.string(),
  balance: z.string(),
});

export type UpdateBalanceState = { error?: string };

export async function updateDebtBalance(
  _prev: UpdateBalanceState,
  formData: FormData,
): Promise<UpdateBalanceState> {
  const session = await requireOwner();

  const parsed = updateBalanceSchema.safeParse({
    debtId: formData.get("debtId"),
    balance: formData.get("balance"),
  });
  if (!parsed.success) return { error: "Invalid input" };

  const debt = await db.debt.findUnique({ where: { id: parsed.data.debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return { error: "Not found" };

  const balanceCents = parseDollarsToCents(parsed.data.balance);
  if (balanceCents === null) return { error: "Enter a valid balance." };

  await db.debt.update({
    where: { id: debt.id },
    data: {
      ...debtBalanceUpdate(debt, balanceCents),
    },
  });
  await unhideDebtPaymentIfBalanceReturned(debt.id, debt.balanceCents, balanceCents, debt.paidOffDate);
  revalidateHousehold();
  return {};
}

const renameDebtSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export type RenameDebtState = { error?: string };

// The manual-debt counterpart to renameAccount (settings/accounts/actions.ts)
// — a manual Debt's `name` had no rename affordance anywhere at all before
// this (only ever set once, at creation). Writes `name` directly rather than
// a separate displayName field the way renameAccount does: a manual debt has
// no sync to fight with for that field, unlike a SIMPLEFIN-linked one. Every
// place a debt name renders should prefer this over whatever it was created
// with — see the networth HOME_EQUITY/VEHICLE_EQUITY entry in WORKING_ON.md,
// which now reads a linked debt's name as its own display name.
export async function renameDebt(
  debtId: string,
  _prev: RenameDebtState,
  formData: FormData,
): Promise<RenameDebtState> {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return { error: "Not found." };

  const parsed = renameDebtSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await db.debt.update({ where: { id: debtId }, data: { name: parsed.data.name } });
  revalidateHousehold();
  return {};
}

const updateTermsSchema = z.object({
  apr: z.string(),
  // Optional — a `disabled` input is omitted from its form's submission
  // entirely (standard HTML behavior), and the minPayment field is disabled
  // client-side whenever ignoreMinimum is checked. Still required in
  // practice whenever ignoreMinimum ISN'T checked — enforced below, once
  // parsed.data.ignoreMinimum is known, not by the schema itself.
  minPayment: z.string().optional(),
  // Checkbox — "on" (or any truthy string) when checked, absent when not.
  // See ignoreMinimumPayment on the Debt model.
  ignoreMinimum: z.string().optional(),
  // Same optional due-date consolidation as createDebt — pre-filled from
  // the linked DebtPayment's nextDueDate when one already exists.
  dueDay: z.string().optional(),
  // The linked DebtPayment tracker's bucket/category (2026-09-08 — the
  // revolving manual-debt editor gained these fields, matching the
  // installment path; only applied to an already-existing tracker).
  bucketId: z.string().optional(),
  categoryId: z.string().optional(),
  // Present only on the resubmit after dueDateConfirm below round-trips —
  // the household's explicit pick between the two dates that made the plain
  // day-of-month ambiguous. Absent on a normal (non-ambiguous) submit.
  dueDateConfirmed: z.enum(["this", "next"]).optional(),
});

export type UpdateTermsState = { error?: string };

export async function updateDebtTerms(
  debtId: string,
  _prev: UpdateTermsState,
  formData: FormData,
): Promise<UpdateTermsState> {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return { error: "Not found" };

  const parsed = updateTermsSchema.safeParse({
    apr: formData.get("apr"),
    // A disabled input (minPayment, whenever ignoreMinimum is checked) is
    // omitted from the submission entirely — FormData.get then returns
    // null, not undefined, which a plain z.string().optional() rejects
    // ("expected string, received null") unless normalized here.
    minPayment: formData.get("minPayment") || undefined,
    ignoreMinimum: formData.get("ignoreMinimum") || undefined,
    dueDay: formData.get("dueDay") || undefined,
    bucketId: formData.get("bucketId") || undefined,
    categoryId: formData.get("categoryId") || undefined,
    dueDateConfirmed: formData.get("dueDateConfirmed") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
  const ignoreMinimumPayment = Boolean(parsed.data.ignoreMinimum);
  // No real minimum to enter once ignoreMinimumPayment is checked — forced
  // to 0 server-side (the field is disabled and omitted from the submit
  // entirely in that case, see minPayment above) so a stale/leftover value
  // can never sneak back in as a real minimum.
  const minPaymentCents = ignoreMinimumPayment ? 0 : parseDollarsToCents(parsed.data.minPayment ?? "");
  if (aprBasisPoints === null || minPaymentCents === null) {
    return { error: "Enter a valid APR and minimum payment." };
  }

  // The form's APR/min fields are always present on submit, so saving it is
  // itself the confirmation — flips a bare-quick-created debt's
  // termsConfirmed back to true the first time its real terms get set.
  await db.debt.update({
    where: { id: debtId },
    data: {
      aprBasisPoints,
      minPaymentCents,
      termsConfirmed: true,
      ignoreMinimumPayment,
    },
  });
  if (parsed.data.dueDay) {
    const day = parseDueDay(parsed.data.dueDay);
    if (day === null) return { error: "Enter a valid due date." };
    const rollForward = nextOccurrenceOfDay(day);
    let nextDueDate = rollForward;
    // Confirming the due date must not roll past an unpaid current cycle —
    // same fix as bills/actions.ts's updateBill (2026-08-30 Fairview Water
    // Improvement District incident, never ported here). If this debt has
    // real payment history but nothing yet this period, and the chosen day
    // has already gone by this month, nextOccurrenceOfDay lands in *next*
    // month — skipping the now-overdue cycle, hiding it from This Week's
    // Bills entirely (real report, 2026-09-06: Voyager Loan vanished after
    // its due day was corrected to the 3rd, today being the 5th). A debt
    // with no payment history yet keeps the forward roll — its first due
    // date is legitimately upcoming.
    const existingTracker = await db.debtPayment.findUnique({ where: { debtId } });
    if (existingTracker?.lastPaidDate) {
      const { start: periodStart } = utcPeriodBounds(currentPeriodKey());
      const paidThisPeriod = existingTracker.lastPaidDate >= periodStart;
      if (!paidThisPeriod) {
        const thisMonth = currentMonthOccurrenceOfDay(day);
        if (rollForward > thisMonth) {
          // Genuinely ambiguous, not a case the heuristic can safely guess:
          // the chosen day already passed this month AND the current cycle
          // is still unpaid, so "this month" (a correction to an overdue
          // cycle) and "next month" (a real, later change) are both
          // plausible readings of the same plain day-of-month.
          // manual-debt-editor.tsx asks client-side (a confirm() gate, same
          // technique it already uses for the loan-balance-increase check
          // just above) and resubmits with dueDateConfirmed set — household
          // decision, 2026-09-06, in place of a full date picker. Falls back
          // to the "this month" heuristic if some other caller ever submits
          // this without going through that gate, rather than guessing the
          // riskier "silently skip a real overdue cycle" direction.
          nextDueDate = parsed.data.dueDateConfirmed === "next" ? rollForward : thisMonth;
        }
      }
    }
    await upsertDebtPayment(session.user.householdId, debtId, {
      amountCents: minPaymentCents,
      nextDueDate,
    });
  } else {
    // dueDay is only omitted when no DebtPayment tracker exists yet (a
    // brand-new manual debt with no due date set) — DayOfMonthPicker always
    // resubmits *some* day once a tracker exists. Real household report,
    // 2026-08-21: editing just the minimum payment on an already-tracked
    // debt silently left the stale tracker's amountCents (and nextDueDate)
    // untouched because that save's dueDay came back empty, so
    // Debt.minPaymentCents and DebtPayment.amountCents drifted apart with no
    // way to fix it short of touching the due-date picker. The client-side
    // root cause (manual-debt-editor.tsx's dueDay local state was seeded
    // once on mount and never re-synced if the tracker's real due date
    // changed later while the form stayed open — e.g. a background sync
    // attaching/advancing a tracker) was fixed the same day via that
    // component's own prevNextDueDate re-seed (its "Re-seed whenever the
    // tracked due date itself changes" comment cites this exact incident) —
    // so dueDay now only ever comes back genuinely empty for the real
    // no-tracker-yet case this branch handles, not a stale one. Guard
    // belt-and-suspenders here too, for a caller that predates or bypasses
    // that client fix: if a tracker already exists, always keep its amount
    // in sync regardless of what dueDay evaluated to. (A tighter race
    // remains, unfixed by either side: a sync landing between this form's
    // last render and an in-flight submit — no optimistic-concurrency token
    // guards that window. Narrow enough, and would need a bigger change to
    // close, that it's accepted rather than chased further here.)
    const existing = await db.debtPayment.findUnique({ where: { debtId } });
    if (existing) {
      await db.debtPayment.update({
        where: { id: existing.id },
        data: { amountCents: minPaymentCents, amountDueCents: minPaymentCents },
      });
    }
  }
  // Bucket/category ride on the linked DebtPayment tracker (same place the
  // installment path stores them). Only ever applied to an existing tracker
  // — a revolving debt with no due date set has no DebtPayment row yet, so
  // there's nothing to attach them to until one is created. Unlike the
  // installment path, no "BNPL" category is auto-created for a card/loan —
  // an unpicked category just stays cleared.
  if (parsed.data.bucketId !== undefined || parsed.data.categoryId !== undefined) {
    const tracker = await db.debtPayment.findUnique({ where: { debtId } });
    if (tracker) {
      const resolvedBucketId =
        parsed.data.bucketId || (await defaultDebtPaymentBucketId(session.user.householdId));
      const resolvedCategoryId =
        parsed.data.categoryId && resolvedBucketId
          ? ((
              await db.billCategory.findFirst({
                where: { id: parsed.data.categoryId, householdId: session.user.householdId, bucketId: resolvedBucketId },
              })
            )?.id ?? null)
          : null;
      await db.debtPayment.update({
        where: { id: tracker.id },
        data: { bucketId: resolvedBucketId, categoryId: resolvedCategoryId },
      });
      if (tracker.bucketId) revalidateHousehold();
      if (resolvedBucketId) revalidateHousehold();
    }
  }
  revalidateHousehold();
  return {};
}

const updateInstallmentSchema = z.object({
  apr: z.string(),
  paymentAmount: z.string(),
  totalPayments: z.coerce.number().int().min(1).max(600),
  currentPayment: z.coerce.number().int().min(1).max(600),
  cadence: cadenceEnum,
  tolerance: z.string().optional(),
  // Optional (2026-08-16) — a legacy BNPL debt from before purchaseDate/
  // DebtPayment tracking existed may not have one yet; leaving it blank
  // here just skips upsertInstallmentDebtPayment's matching setup rather
  // than erroring, since the household may only be correcting the payment
  // count today.
  purchaseDate: z.string().optional(),
  // Optional — the first installment's due date when it isn't the purchase
  // date (see installmentSchema). On an edit it repositions an un-started
  // plan's nextDueDate; once real payments have matched, matchInstallmentPayments
  // owns that date and this is ignored.
  firstPaymentDate: z.string().optional(),
  // Optional — falls back to defaultDebtPaymentBucketId when left blank
  // (see upsertInstallmentDebtPayment).
  bucketId: z.string().optional(),
  categoryId: z.string().optional(),
});

export type UpdateInstallmentState = { error?: string };

// The INSTALLMENT-debt counterpart to updateDebtTerms/updateDebtBalance:
// BNPL merchants never get a SimpleFIN feed, so "how far along the plan am
// I" has to be re-entered by hand — recomputes installmentsRemaining and
// balanceCents from (total, current payment #) the same way createDebt does.
// Also upserts the linked DebtPayment tracker (cadence/tolerance/bucket,
// see upsertInstallmentDebtPayment) — the same "one form, one save"
// consolidation updateDebtTerms already does for REVOLVING via
// upsertDebtPayment, and how a legacy BNPL debt (no tracker yet) opts into
// automatic matching for the first time.
export async function updateInstallmentTerms(
  debtId: string,
  _prev: UpdateInstallmentState,
  formData: FormData,
): Promise<UpdateInstallmentState> {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return { error: "Not found" };

  const parsed = updateInstallmentSchema.safeParse({
    apr: formData.get("apr"),
    paymentAmount: formData.get("paymentAmount"),
    totalPayments: formData.get("totalPayments"),
    currentPayment: formData.get("currentPayment"),
    cadence: formData.get("cadence"),
    tolerance: formData.get("tolerance") || undefined,
    purchaseDate: formData.get("purchaseDate") || undefined,
    firstPaymentDate: formData.get("firstPaymentDate") || undefined,
    bucketId: formData.get("bucketId") || undefined,
    categoryId: formData.get("categoryId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (parsed.data.currentPayment > parsed.data.totalPayments) {
    return { error: "Current payment can't be past the total number of payments." };
  }

  const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
  const paymentCents = parseDollarsToCents(parsed.data.paymentAmount);
  if (aprBasisPoints === null || paymentCents === null || paymentCents === 0) {
    return { error: "Enter a valid APR and payment amount." };
  }
  const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
  if (!tolerance.ok) return { error: "Enter a valid tolerance." };
  let purchaseDate: Date | null = null;
  if (parsed.data.purchaseDate) {
    purchaseDate = new Date(parsed.data.purchaseDate);
    if (Number.isNaN(purchaseDate.getTime())) return { error: "Enter a valid purchase date." };
  }
  let firstDueDate: Date | null = null;
  if (parsed.data.firstPaymentDate) {
    firstDueDate = new Date(parsed.data.firstPaymentDate);
    if (Number.isNaN(firstDueDate.getTime())) return { error: "Enter a valid first payment date." };
  }

  const installmentsRemaining = installmentsRemainingFrom(parsed.data.totalPayments, parsed.data.currentPayment);
  const balanceCents = paymentCents * installmentsRemaining;
  await db.debt.update({
    where: { id: debtId },
    data: {
      aprBasisPoints,
      minPaymentCents: paymentCents,
      installmentsTotal: parsed.data.totalPayments,
      installmentsRemaining,
      ...debtBalanceUpdate(debt, balanceCents),
    },
  });
  await unhideDebtPaymentIfBalanceReturned(debtId, debt.balanceCents, balanceCents, debt.paidOffDate);
  await upsertInstallmentDebtPayment(session.user.householdId, debtId, {
    amountCents: paymentCents,
    cadence: parsed.data.cadence,
    toleranceCents: tolerance.value ?? 10, // $0.10 default — see the schema comment on DebtPayment
    purchaseDate,
    firstDueDate,
    bucketId: parsed.data.bucketId ?? null,
    categoryId: parsed.data.categoryId ?? null,
  });
  revalidateHousehold();
  return {};
}

// Standalone one-off label edit (2026-08-26 — pulled out of updateDebtTerms/
// updateInstallmentTerms' bigger Save forms) — same inline click-to-edit UX
// as a transaction's own label (TransactionLabelEditor/updateTransactionLabel,
// buckets/actions.ts) instead of being buried in the "edit balance/APR/etc."
// panel behind the pencil icon. Works for either debt type, unlike that
// transaction-side action (which only ever reaches an INSTALLMENT debt's
// label, via whichever transaction happens to be open) — this is the one
// place a REVOLVING debt's label (a promo deadline, say) can be edited at
// all now that updateDebtTerms no longer touches it.
export async function updateDebtLabel(debtId: string, label: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  await db.debt.update({ where: { id: debtId }, data: { label: label.trim().slice(0, 120) || null } });
  revalidateHousehold();
}

export async function linkDebtAccount(debtId: string, accountId: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  if (!accountId) {
    await db.debt.update({ where: { id: debtId }, data: { accountId: null, source: "MANUAL" } });
    revalidateHousehold();
    return;
  }

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  // "Stealing" an account already claimed by a different debt — the UI
  // (account-editor.tsx / manual-debt-editor.tsx "Linked Account" controls)
  // confirms with the household first, since this unlinks that other debt
  // as a side effect (it becomes MANUAL, keeping its own balance/terms/
  // history — nothing is deleted). Exists for a SimpleFIN reconnect that
  // reissues a brand-new account id for the same real-world account instead
  // of cleanly replacing the old one: real report, 2026-09-14 — Sam's Club
  // switched to connecting via Synchrony, which synced as an entirely new,
  // blank "Needs Setup" Debt while the household's real, already-configured
  // debt (bucket/category/cadence tracker, payoff-plan membership) stayed
  // pointed at the old, now-stale account. Without this, reuniting them took
  // a database query — Account.id carries no unique constraint against
  // Debt.accountId, so nothing else would have caught two debts pointing at
  // the same account.
  await db.debt.updateMany({ where: { accountId, id: { not: debtId } }, data: { accountId: null, source: "MANUAL" } });

  // Liability-account convention (simplefin-sync.ts): balanceCents is
  // negative when a real balance is owed, positive/zero when the account is
  // in credit (an overpayment, a refund posted after paying in full) — never
  // just the raw magnitude. Math.abs() here used to turn a genuinely-$0-owed
  // in-credit account into an equal amount of phantom debt; this now matches
  // the same Math.max(0, -balanceCents) convention simplefin-sync.ts's own
  // sync path already uses.
  const balanceCents = Math.max(0, -account.balanceCents);
  // Only a genuinely first-time link (this debt had no account before) can
  // represent a real "was $0, now has a balance" transition worth notifying
  // on — re-pointing an *already-linked* debt at a different account (the
  // "Linked Account" control, settings/accounts/account-editor.tsx) is a
  // household correcting which account this debt maps to, not the balance
  // actually changing, so the two balances being compared don't belong to
  // the same real-world account at two points in time and firing
  // DEBT_BALANCE_RETURNED off that comparison would be a false positive.
  const wasAlreadyLinked = debt.accountId !== null;
  const oldAccountId = debt.accountId;
  // Carry the household's own friendly rename forward across a re-point, so
  // the debt reads exactly as it did before (household request, 2026-09-14,
  // same Sam's Club incident above) — a freshly-synced replacement account
  // almost never has its own Account.displayName set yet, and without this
  // the debt suddenly started showing its raw bank-provided name again the
  // moment it moved onto the new account. Never overwrites an explicit
  // rename already sitting on the target account.
  // Same carry-forward for the household's own "Use for Transactions" toggle
  // (Account.budgetTracked) — a freshly-synced replacement account defaults
  // this from its accountType (simplefin-sync.ts), which is false for any
  // CREDIT_CARD/LOAN, silently reverting a household's manual opt-in the
  // moment SimpleFIN reissues the account id (same Sam's Club incident,
  // 2026-09-14).
  if (wasAlreadyLinked && debt.accountId) {
    const oldAccount = await db.account.findUnique({
      where: { id: debt.accountId },
      select: { displayName: true, budgetTracked: true },
    });
    const data: Prisma.AccountUpdateInput = {};
    if (oldAccount?.displayName && !account.displayName) data.displayName = oldAccount.displayName;
    if (oldAccount && oldAccount.budgetTracked !== account.budgetTracked) data.budgetTracked = oldAccount.budgetTracked;
    if (Object.keys(data).length > 0) {
      await db.account.update({ where: { id: accountId }, data });
    }
  }
  await db.debt.update({
    where: { id: debtId },
    data: {
      accountId,
      source: "SIMPLEFIN",
      ...debtBalanceUpdate(debt, balanceCents),
    },
  });
  // Unconditional, not gated on wasAlreadyLinked — a re-point (SimpleFIN
  // reissuing a new account id) can be exactly how a paid-off-then-restored
  // balance is *discovered* when the old account's own feed already went
  // stale before it ever saw the new charge (real report, 2026-09-14: Sam's
  // Club's old account last synced 2026-09-11 still reporting $0, so the
  // relink onto the new Synchrony-issued account was the household's first
  // real read of the restored $175.78 balance). Skipping this here left
  // ignoreMinimumPayment/hiddenFromBucket never re-asked, silently
  // inconsistent with a real positive balance. Safe to call unconditionally:
  // the one thing this guard protected against — over-firing
  // DEBT_BALANCE_RETURNED on an ordinary same-moment re-point where nothing
  // really changed — is already handled inside unhideDebtPaymentIfBalanceReturned
  // itself, which only fires the push when something was actually hidden or
  // debt.paidOffDate (read above, before this update) was genuinely set.
  await unhideDebtPaymentIfBalanceReturned(debtId, debt.balanceCents, balanceCents, debt.paidOffDate);
  // Immediately hide the account this debt just moved off of, once nothing
  // else references it — rather than waiting on simplefin-sync.ts's 2-hour
  // missing-from-feed grace period (hideAccountsWithLinkedDebts). A
  // household re-pointing a debt here is an explicit, unambiguous signal
  // that the old account is done, much stronger than a sync merely not
  // seeing it this cycle — leaving it sitting in Connected Accounts as a
  // "Not Tracked" row reads as a real actionable account (still surfaces
  // its own "Track It" nudge) when it's actually just a stale duplicate
  // from a bank reconnect (household report, 2026-09-14, same Sam's Club
  // incident above). Checked, not assumed: only hides once genuinely
  // orphaned (no other Debt/Asset/SavingsGoal still pointing at it).
  if (wasAlreadyLinked && oldAccountId && oldAccountId !== accountId) {
    const counts = await Promise.all([
      db.debt.count({ where: { accountId: oldAccountId } }),
      db.asset.count({ where: { accountId: oldAccountId } }),
      db.savingsGoal.count({ where: { accountId: oldAccountId } }),
    ]);
    const stillReferenced = counts.some((c) => c > 0);
    if (!stillReferenced) {
      await db.account.update({ where: { id: oldAccountId }, data: { hiddenAt: new Date() } });
    }
  }
  await reassignTransactionsForDebt(debtId);
  revalidateHousehold();
}

const trackAccountSchema = z.object({
  apr: z.string(),
  minPayment: z.string(),
  // Same optional due-date consolidation as createDebt/updateDebtTerms.
  dueDay: z.string().optional(),
});

export type TrackAccountState = { error?: string };

// One-step "start tracking this synced card/loan as a Debt" — the balance
// and name are already known from the sync, so this only needs to ask for
// the things SimpleFIN doesn't give us: APR, minimum payment, and now
// (optionally) a due date.
export async function trackAccountAsDebt(
  accountId: string,
  _prev: TrackAccountState,
  formData: FormData,
): Promise<TrackAccountState> {
  const session = await requireOwner();

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return { error: "Account not found." };

  const parsed = trackAccountSchema.safeParse({
    apr: formData.get("apr"),
    minPayment: formData.get("minPayment"),
    dueDay: formData.get("dueDay") || undefined,
  });
  if (!parsed.success) return { error: "Invalid input" };

  const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
  const minPaymentCents = parseDollarsToCents(parsed.data.minPayment);
  if (aprBasisPoints === null || minPaymentCents === null) {
    return { error: "Enter a valid APR and minimum payment." };
  }
  let dueDate: Date | null = null;
  if (parsed.data.dueDay) {
    const day = parseDueDay(parsed.data.dueDay);
    if (day === null) return { error: "Enter a valid due date." };
    dueDate = nextOccurrenceOfDay(day);
  }

  const maxSort = await db.debt.aggregate({
    where: { householdId: session.user.householdId },
    _max: { sortOrder: true },
  });

  const newDebt = await db.debt.create({
    data: {
      householdId: session.user.householdId,
      name: account.name,
      debtType: "REVOLVING",
      // Pre-set from the linked account's own type instead of falling back
      // to DebtKind's CARD default — a tracked LOAN account otherwise never
      // shows up as a loan anywhere that groups by kind (payoff planner's
      // composition chart) until someone notices and flips it by hand in
      // AccountEditor.
      kind: account.accountType === "LOAN" ? "LOAN" : "CARD",
      aprBasisPoints,
      minPaymentCents,
      // See linkDebtAccount's identical fix above — negative balanceCents is
      // a real balance owed, positive/zero is in-credit, never a raw
      // magnitude.
      balanceCents: Math.max(0, -account.balanceCents),
      accountId: account.id,
      source: "SIMPLEFIN",
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
  });
  await reassignTransactionsForDebt(newDebt.id);
  if (dueDate) {
    await upsertDebtPayment(session.user.householdId, newDebt.id, { amountCents: minPaymentCents, nextDueDate: dueDate });
  }
  revalidateHousehold();

  revalidateHousehold();
  return {};
}


export type DebtPaymentFormState = { error?: string };

// updateDebtPayment (the debt-payment counterpart to updateBill — amount/
// cadence/tolerance/category/due date/bucket on an existing DebtPayment) was
// removed 2026-09-12: it only ever backed DebtPaymentRow's own inline edit
// form, which now always defers to Settings (updateSyncedDebtTerms for a
// synced debt, updateDebtTerms/updateInstallmentTerms for a manual one —
// see DebtPaymentRow's own comment on why editing moved there). No other
// caller ever used it. DebtPaymentFormState itself stays — still the return
// shape for createDebtPaymentFromTransaction below.

const updateSyncedDebtTermsSchema = z.object({
  apr: z.string(),
  // Optional — a `disabled` input is omitted from its form's submission
  // entirely (standard HTML behavior), and this field is disabled
  // client-side whenever ignoreMinimum is checked. Still required in
  // practice whenever ignoreMinimum ISN'T checked — enforced below, once
  // parsed.data.ignoreMinimum is known, not by the schema itself.
  minPayment: z.string().optional(),
  // Checkbox — "on" (or any truthy string) when checked, absent when not.
  // See ignoreMinimumPayment on the Debt model.
  ignoreMinimum: z.string().optional(),
  cadence: cadenceEnum,
  dueDay: z.string().min(1),
  tolerance: z.string().optional(),
  categoryId: z.string().optional(),
  bucketId: z.string().optional(),
});

export type UpdateSyncedDebtTermsState = { error?: string };

// The single consolidated replacement for updateDebtTerms + updateDebtPayment
// when a debt is linked to a synced account (2026-08-15 account-settings
// consolidation) — those two previously wrote the same underlying fields
// (DebtPayment.nextDueDate, Debt.minPaymentCents) from two separate forms on
// /debts. Rendered from settings/accounts/page.tsx instead; /debts shows
// this data read-only for a linked debt (see debt-row.tsx). Manual/unlinked
// debts keep using updateDebtTerms + updateDebtPayment exactly as before —
// this action errors if the debt isn't actually linked to an account.
export async function updateSyncedDebtTerms(
  debtId: string,
  _prev: UpdateSyncedDebtTermsState,
  formData: FormData,
): Promise<UpdateSyncedDebtTermsState> {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return { error: "Not found" };
  if (!debt.accountId) return { error: "This debt isn't linked to a synced account." };

  const parsed = updateSyncedDebtTermsSchema.safeParse({
    apr: formData.get("apr"),
    // A disabled input (minPayment, whenever ignoreMinimum is checked) is
    // omitted from the submission entirely — FormData.get then returns
    // null, not undefined, which a plain z.string().optional() rejects
    // ("expected string, received null") unless normalized here.
    minPayment: formData.get("minPayment") || undefined,
    ignoreMinimum: formData.get("ignoreMinimum") || undefined,
    cadence: formData.get("cadence"),
    dueDay: formData.get("dueDay"),
    tolerance: formData.get("tolerance") || undefined,
    categoryId: formData.get("categoryId") || undefined,
    bucketId: formData.get("bucketId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const aprBasisPoints = parsePercentToBasisPoints(parsed.data.apr);
  const ignoreMinimumPayment = Boolean(parsed.data.ignoreMinimum);
  // $0 is a legitimate minimum payment — a card sitting at a $0 balance
  // genuinely owes nothing (real incident, 2026-08-15: this blocked setting
  // up a $0-balance Discover card at all, with a misleading "enter a valid
  // APR and minimum payment" error even though both were entered). A card
  // with a real balance and genuinely no minimum uses ignoreMinimumPayment
  // instead (forced to 0 here — the field is disabled and omitted from the
  // submit entirely in that case, see minPayment above) — see needsSetup
  // below for how a debt that's neither of those and still carries a $0
  // minimum gets flagged again.
  const minPaymentCents = ignoreMinimumPayment ? 0 : parseDollarsToCents(parsed.data.minPayment ?? "");
  if (aprBasisPoints === null || minPaymentCents === null) {
    return { error: "Enter a valid APR and minimum payment." };
  }

  const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
  if (!tolerance.ok) return { error: "Enter a valid tolerance." };

  const dueDay = parseDueDay(parsed.data.dueDay);
  if (dueDay === null) return { error: "Enter a valid due date." };
  const dueDate = nextOccurrenceOfDay(dueDay);

  let resolvedBucketId: string | null = null;
  if (parsed.data.bucketId) {
    const bucket = await db.bucket.findFirst({
      where: { id: parsed.data.bucketId, householdId: session.user.householdId },
    });
    resolvedBucketId = bucket?.id ?? null;
  } else {
    // Same default the sync-time self-heal and every other DebtPayment
    // creation site already apply — see defaultDebtPaymentBucketId.
    resolvedBucketId = await defaultDebtPaymentBucketId(session.user.householdId);
  }

  // Scoped to resolvedBucketId — see the schema comment on
  // BillCategory.bucketId.
  let resolvedCategoryId: string | null = null;
  if (parsed.data.categoryId && resolvedBucketId) {
    const category = await db.billCategory.findFirst({
      where: { id: parsed.data.categoryId, householdId: session.user.householdId, bucketId: resolvedBucketId },
    });
    resolvedCategoryId = category?.id ?? null;
  }

  await db.debt.update({
    where: { id: debtId },
    data: { aprBasisPoints, minPaymentCents, termsConfirmed: true, ignoreMinimumPayment },
  });

  const existing = await db.debtPayment.findUnique({ where: { debtId } });
  if (existing) {
    await db.debtPayment.update({
      where: { id: existing.id },
      data: {
        amountCents: minPaymentCents,
        // Same reasoning as upsertDebtPayment above — a human confirming
        // terms here resets any carried-over shortfall against the old
        // amount.
        amountDueCents: minPaymentCents,
        cadence: parsed.data.cadence,
        toleranceCents: tolerance.value,
        categoryId: resolvedCategoryId,
        nextDueDate: dueDate,
        dueDateLocked: true,
        bucketId: resolvedBucketId,
      },
    });
  } else {
    const created = await db.debtPayment.create({
      data: {
        householdId: session.user.householdId,
        debtId,
        amountCents: minPaymentCents,
        amountDueCents: minPaymentCents,
        cadence: parsed.data.cadence,
        toleranceCents: tolerance.value,
        categoryId: resolvedCategoryId,
        nextDueDate: dueDate,
        dueDateLocked: true,
        bucketId: resolvedBucketId,
      },
    });
    await backfillDebtPaymentHistory(session.user.householdId, created);
  }

  revalidateHousehold();
  return {};
}

const createDebtPaymentFromTransactionSchema = z.object({
  amount: z.string(),
  tolerance: z.string().optional(),
  cadence: cadenceEnum,
  // Always an existing debt now — see AddDebtModal (src/app/buckets/[id]/
  // add-debt-modal.tsx), which creates a brand new one (via the same
  // createDebt action Settings' AddDebtForm uses) and hands its id straight
  // back to TrackAsBillForm's picker, rather than this action creating a
  // bare name-only stub inline the way it used to (household feedback
  // 2026-08-20: that stub didn't match what Settings actually asks for).
  debtId: z.string(),
  // Optional — if given, this is a human explicitly setting the due date
  // right now, so it starts locked/confirmed instead of approximated from
  // this one transaction's date. Day-of-month (dueDay) when cadence is
  // MONTHLY, a full date (nextDueDate) otherwise — same split as
  // updateDebtPaymentSchema above.
  dueDay: z.string().optional(),
  nextDueDate: z.string().optional(),
});

// The debt-payment counterpart to createBillFromTransaction in
// src/app/bills/actions.ts — turns a transaction into a tracked
// DebtPayment instead of a RecurringBill. Used by TrackAsBillForm's debt
// dropdown.
export async function createDebtPaymentFromTransaction(
  transactionId: string,
  _prev: DebtPaymentFormState,
  formData: FormData,
): Promise<DebtPaymentFormState> {
  const session = await requireOwner();

  const transaction = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!belongsToHousehold(transaction, session.user.householdId)) return { error: "Not found." };
  if (transaction.billId || transaction.debtPaymentId) return { error: "Already tracked." };

  const parsed = createDebtPaymentFromTransactionSchema.safeParse({
    amount: formData.get("amount"),
    tolerance: formData.get("tolerance") || undefined,
    cadence: formData.get("cadence"),
    debtId: formData.get("debtId"),
    dueDay: formData.get("dueDay") || undefined,
    nextDueDate: formData.get("nextDueDate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) return { error: "Enter a valid amount." };

  const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
  if (!tolerance.ok) return { error: "Enter a valid tolerance." };

  const debt = await db.debt.findFirst({ where: { id: parsed.data.debtId, householdId: session.user.householdId } });
  if (!debt) return { error: "Debt not found." };
  // Defensive — the picker upstream already excludes an already-tracked
  // debt (src/app/transactions/page.tsx's debtOptions), but a stale client
  // could still submit a stale value.
  if (await db.debtPayment.findUnique({ where: { debtId: debt.id } })) {
    return { error: "This debt already has a tracked payment." };
  }
  const debtId = debt.id;

  let explicitDueDate: Date | null = null;
  if (parsed.data.cadence === "MONTHLY" && parsed.data.dueDay) {
    const day = parseDueDay(parsed.data.dueDay);
    if (day === null) return { error: "Enter a valid due date." };
    explicitDueDate = nextOccurrenceOfDay(day);
  } else if (parsed.data.nextDueDate) {
    explicitDueDate = new Date(parsed.data.nextDueDate);
    if (Number.isNaN(explicitDueDate.getTime())) return { error: "Enter a valid due date." };
  }

  const debtPayment = await db.debtPayment.create({
    data: {
      householdId: session.user.householdId,
      debtId,
      amountCents,
      amountDueCents: amountCents,
      toleranceCents: tolerance.value,
      cadence: parsed.data.cadence,
      nextDueDate: explicitDueDate ?? nextBillDueDate(parsed.data.cadence, transaction.occurredOn, [transaction.occurredOn]),
      lastPaidDate: transaction.occurredOn,
      dueDateLocked: Boolean(explicitDueDate),
      // See defaultDebtPaymentBucketId — shows up in Bills immediately.
      bucketId: await defaultDebtPaymentBucketId(session.user.householdId),
    },
  });

  // Tag the transaction as a transfer toward this debt first (but leave
  // debtPaymentId unset) so backfillDebtPaymentHistory can find it via its
  // own `isTransfer / debtId / debtPaymentId: null` query and both link it
  // AND credit it against the freshly-created amountDueCents — same as
  // upsertDebtPayment / updateSyncedDebtTerms already do. Without this the
  // tracker was born owing a full cycle with its own cycle-satisfying
  // payment attached-but-uncredited, so it showed "due" on the dashboard
  // Payoff Calendar forever (matchDebtPayments' ongoing sweep only ever
  // looks at debtPaymentId: null rows).
  await db.transaction.update({
    where: { id: transactionId },
    data: {
      ...CLEARED_CLASSIFICATION,
      debtId,
      isTransfer: true,
    },
  });

  await backfillDebtPaymentHistory(session.user.householdId, debtPayment);

  // Backfill only reaches one cadence period back from nextDueDate — if the
  // human pointed at an older transaction, link it explicitly anyway (it
  // stays uncredited against the backlog, same bound matchDebtPayments uses).
  // Skip if its offsetting card/loan-side twin is already linked to this
  // tracker — linking both legs double-counts every DebtPayment.payments sum.
  const [twinSurvivor] = await filterDebtPaymentTwins(
    debtPayment.id,
    [
      {
        id: transaction.id,
        amountCents: transaction.amountCents,
        occurredOn: transaction.occurredOn,
        accountId: transaction.accountId,
      },
    ],
    debt.accountId,
  );
  if (twinSurvivor) {
    await db.transaction.updateMany({
      where: { id: transactionId, debtPaymentId: null },
      data: { debtPaymentId: debtPayment.id },
    });
  }

  await upsertMerchantRule(
    session.user.householdId,
    transaction.merchant,
    { bucketId: null, debtId, categoryId: null, isTransfer: true, isIncome: false },
    { confidence: 1, source: "USER" },
  );

  revalidateHousehold();
  return {};
}

// The debt-payment counterpart to acceptBillSuggestion — accepts a
// suggestion from detectDebtPaymentSuggestions (src/lib/debt-payments.ts),
// creating a DebtPayment instead of a RecurringBill.
export async function acceptDebtPaymentSuggestion(
  key: string,
  debtId: string,
  amountCents: number,
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL",
  categoryId: string | null,
  nextDueDate: string,
  transactionIds: string[],
  isCreditCard: boolean,
) {
  const session = await requireOwner();

  const debt = await db.debt.findFirst({ where: { id: debtId, householdId: session.user.householdId } });
  if (!debt) return;
  if (await db.debtPayment.findUnique({ where: { debtId } })) return;

  // See defaultDebtPaymentBucketId — shows up in Bills immediately. Resolved
  // before category (moved up 2026-08-23) since a category now has to be
  // scoped to this same bucket — see the schema comment on
  // BillCategory.bucketId.
  const resolvedBucketId = await defaultDebtPaymentBucketId(session.user.householdId);

  let resolvedCategoryId =
    categoryId && resolvedBucketId
      ? ((await db.billCategory.findFirst({ where: { id: categoryId, householdId: session.user.householdId, bucketId: resolvedBucketId } }))?.id ?? null)
      : null;

  // Household explicitly asked for "Card payment" to be its own category,
  // same level as "Loan payment" — auto-apply it (creating it once, on
  // first use) instead of making every household discover and set this up
  // by hand.
  if (!resolvedCategoryId && isCreditCard && resolvedBucketId) {
    const existing = await db.billCategory.findUnique({
      where: { bucketId_name: { bucketId: resolvedBucketId, name: "Card payment" } },
    });
    resolvedCategoryId = existing
      ? existing.id
      : (await db.billCategory.create({ data: { householdId: session.user.householdId, bucketId: resolvedBucketId, name: "Card payment" } })).id;
  }

  const mostRecent = await db.transaction.findFirst({
    where: { id: { in: transactionIds }, householdId: session.user.householdId },
    orderBy: { occurredOn: "desc" },
    select: { occurredOn: true },
  });

  const debtPayment = await db.debtPayment.create({
    data: {
      householdId: session.user.householdId,
      debtId,
      amountCents,
      amountDueCents: amountCents,
      cadence,
      categoryId: resolvedCategoryId,
      nextDueDate: new Date(nextDueDate),
      lastPaidDate: mostRecent?.occurredOn ?? null,
      bucketId: resolvedBucketId,
    },
  });
  // Credit this cycle's already-synced payment against the freshly-created
  // amountDueCents (and link it) via the same helper upsertDebtPayment /
  // updateSyncedDebtTerms use — the suggestion's transactions are already
  // isTransfer/debtId-tagged (detectDebtPaymentSuggestions), so backfill's
  // own candidate query finds the in-window one directly. Without this the
  // tracker started life owing a full cycle with its cycle-satisfying
  // payment attached-but-uncredited, showing "due" on the dashboard Payoff
  // Calendar forever.
  await backfillDebtPaymentHistory(session.user.householdId, debtPayment);
  // Link the remaining suggestion transactions backfill didn't claim (older
  // than one cadence period — left uncredited against the backlog, same
  // bound matchDebtPayments' ongoing sweep uses). Twin-filter first: backfill
  // may have linked a card-side leg whose checking-side twin is in this set.
  const suggestionRows = await db.transaction.findMany({
    where: { id: { in: transactionIds }, householdId: session.user.householdId, debtPaymentId: null },
    select: { id: true, amountCents: true, occurredOn: true, accountId: true },
  });
  const linkable = await filterDebtPaymentTwins(debtPayment.id, suggestionRows, debt.accountId);
  if (linkable.length > 0) {
    await db.transaction.updateMany({
      where: { id: { in: linkable.map((t) => t.id) } },
      data: { debtPaymentId: debtPayment.id },
    });
  }
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "BILL", key } },
    create: { householdId: session.user.householdId, kind: "BILL", key },
    update: {},
  });

  revalidateHousehold();
}

// The debt-payment counterpart to markBillPaid — manual "mark this cycle
// paid" for a debt payment with no matching transaction yet.
export async function markDebtPaymentPaid(debtPaymentId: string) {
  const session = await requireOwner();

  const debtPayment = await db.debtPayment.findUnique({ where: { id: debtPaymentId } });
  if (!belongsToHousehold(debtPayment, session.user.householdId)) return;

  await db.debtPayment.update({
    where: { id: debtPaymentId },
    data: {
      lastPaidDate: todayAsUTCDate(),
      nextDueDate: nextBillDueDate(debtPayment.cadence, debtPayment.nextDueDate, []),
      // Manual debts have no synced transactions to ever reduce
      // amountDueCents automatically (see matchDebtPayments) — this click
      // is the only signal that a cycle's owed, so it resets the rolling
      // total the same way a real qualifying payment would.
      amountDueCents: debtPayment.amountCents,
    },
  });
  revalidateHousehold();
}

// Inline "Mark Caught Up" on the debt row itself (household feedback,
// 2026-08-26: correcting a wrong "amount due" by going into Account
// Settings "is not obvious") — resets the rolling amountDueCents to a fresh
// cycle's regular minimum, for whenever the calculated carried-over
// shortfall is wrong (a surplus/credit applied that Flow can't see). Unlike
// markDebtPaymentPaid above, deliberately leaves nextDueDate untouched —
// this corrects the *amount*, it doesn't skip the household ahead to the
// next billing cycle.
export async function settleDebtAmountDue(debtPaymentId: string) {
  const session = await requireOwner();

  const debtPayment = await db.debtPayment.findUnique({ where: { id: debtPaymentId } });
  if (!belongsToHousehold(debtPayment, session.user.householdId)) return;

  await db.debtPayment.update({
    where: { id: debtPaymentId },
    data: { amountDueCents: debtPayment.amountCents },
  });
  revalidateHousehold();
}

// The Account Settings "stop showing this" call for a debt — same self-heal
// via unhideDebtPaymentIfBalanceReturned (src/lib/debt-payments.ts) either
// way. A *manual* debt (accountId null) can be hidden any time (2026-08-21 —
// a household can stop tracking one here without having paid it off); a
// debt still linked to a live SimpleFIN Account stays $0-balance-only, same
// as always — hiding a synced account's row is only ever meant to read as
// "this is paid off and I don't need to see it," not a way to make a
// still-owed connected card disappear. Purely a display toggle either way —
// see deleteHiddenItem (src/app/settings/accounts/actions.ts) for how a
// household eventually reclaims one permanently, and restoreDebt below for
// undoing this before then.
//
// Also cascades to this debt's DebtPayment.hiddenFromBucket (2026-08-23,
// household request), so this is the one control that hides the recurring-
// payment card everywhere it shows (every bucket's own Bills section,
// /bills) at the same time it hides the debt from /debts + Settings —
// there used to be a second, lighter "remove from bucket for now" button
// living right on the card (hideDebtPaymentFromBucket, DebtPaymentRow) that
// only ever touched hiddenFromBucket; removed the same day once this cascade
// made it redundant, since a household experienced both as the same "hide
// this" intent and now only needs the one. unhideDebtPaymentIfBalanceReturned
// already treated the two flags as a pair on the way back (clears both the
// moment a paid-off debt gets a new charge) — this completes the same
// pairing on the way in. No balance check on the cascade itself (a manual
// debt can already be hidden with a real balance per the paragraph above,
// and if a household explicitly hides a whole debt from Settings that
// intent should suppress the recurring card regardless). Never touches
// Transaction history or the payoff ledger either way.
export async function hideDebt(debtId: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({
    where: { id: debtId },
    select: { householdId: true, accountId: true, balanceCents: true, debtPayment: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(debt, session.user.householdId)) return;
  if (debt.accountId !== null && debt.balanceCents > 0) return;

  await db.debt.update({ where: { id: debtId }, data: { hiddenAt: new Date() } });
  await db.debtPayment.updateMany({ where: { debtId }, data: { hiddenFromBucket: true } });
  revalidateHousehold();
}

// Undoes hideDebt (or a hide inherited from its Account being removed and
// cascading onto it, see hideAccountsWithLinkedDebts in
// src/lib/simplefin-sync.ts) — available any time, not gated behind the
// year-old purge-eligibility window deleteHiddenItem uses, since a household
// should be able to bring something back the moment they realize they
// still want it, not just when deciding whether to finally delete it. Also
// clears DebtPayment.hiddenFromBucket, undoing hideDebt's own cascade above
// symmetrically.
export async function restoreDebt(debtId: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({
    where: { id: debtId },
    select: { householdId: true, debtPayment: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  await db.debt.update({ where: { id: debtId }, data: { hiddenAt: null } });
  await db.debtPayment.updateMany({ where: { debtId }, data: { hiddenFromBucket: false } });
  revalidateHousehold();
}

// Resolves a pending DebtAmountReview (see matchDebtPayments in
// src/lib/debt-payments.ts) — household confirms the amount really is the
// new minimum: adopt it (on the DebtPayment *and* the Debt, kept in sync)
// and link the transaction. Two different reviews need two different
// treatments of the cycle itself (see DebtAmountReview.cycleAlreadyAdvanced
// in schema.prisma): a below-tolerance underpayment left its cycle unrolled
// pending this answer, so confirming here is also what completes it —
// lastPaidDate/nextDueDate advance now, same as a normal match would have.
// An out-of-band overpayment on a non-priority debt already rolled its
// cycle forward at detection time regardless of the answer (it was never in
// doubt that the obligation was met) — confirming there only updates the
// tracked amount for cycles yet to come; rolling nextDueDate again here
// would skip a whole extra cycle.
export async function confirmDebtAmountChanged(reviewId: string) {
  const session = await requireOwner();

  const review = await db.debtAmountReview.findUnique({ where: { id: reviewId }, include: { debtPayment: true } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  // EMAIL source has no transaction to link — the notice arrives before any
  // payment posts.
  if (review.transactionId) {
    await linkTxnToDebtPaymentGuarded(review.transactionId, review.debtPaymentId);
  }
  await db.debtPayment.update({
    where: { id: review.debtPaymentId },
    data: {
      amountCents: review.observedAmountCents,
      ...(review.cycleAlreadyAdvanced
        ? {}
        : {
            lastPaidDate: todayAsUTCDate(),
            nextDueDate: nextBillDueDate(review.debtPayment.cadence, review.debtPayment.nextDueDate, []),
          }),
      // A bill-notice review states what's newly due this cycle — reflect it
      // in the live rolling total too, but only when the cycle is still
      // untouched (nothing paid/added against it since the notice landed).
      // Never clobber a partially-paid cycle's real remaining balance.
      ...(review.source === "EMAIL" && shouldRefreshAmountDueOnEmailConfirm(review.debtPayment.amountDueCents, review.expectedAmountDueCents)
        ? { amountDueCents: review.observedAmountCents }
        : {}),
    },
  });
  await syncDebtMinPaymentCents(review.debtPayment.debtId, review.observedAmountCents);
  await db.debtAmountReview.delete({ where: { id: reviewId } });

  revalidateHousehold();
}

// Household says no, the minimum didn't change — this was just a
// partial/odd payment. For a below-tolerance review, links it as a plain
// extra (doesn't complete the cycle) and leaves the bill open, same as any
// other below-tolerance candidate matchDebtPayments finds once this review
// no longer blocks it. For an already-advanced overpayment review (see
// DebtAmountReview.cycleAlreadyAdvanced), the cycle was already rolled
// regardless of this answer — the transaction-link update below is then a
// no-op (it was linked as an extra at detection time), so declining just
// clears the question without touching anything else.
export async function declineDebtAmountChanged(reviewId: string) {
  const session = await requireOwner();

  const review = await db.debtAmountReview.findUnique({ where: { id: reviewId } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  if (review.transactionId) {
    await linkTxnToDebtPaymentGuarded(review.transactionId, review.debtPaymentId);
  }
  await db.debtAmountReview.delete({ where: { id: reviewId } });

  revalidateHousehold();
}

// Household says yes, this manual REVOLVING debt's auto-derived $0 balance
// (see DebtBalanceReview's schema comment) is real — the only write path
// that actually zeroes balanceCents and stamps paidOffDate for this flow;
// matchDebtPayments itself deliberately never does either while a review is
// pending.
export async function confirmDebtBalancePaidOff(reviewId: string) {
  const session = await requireOwner();

  const review = await db.debtBalanceReview.findUnique({ where: { id: reviewId }, include: { debt: true } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  await db.debt.update({
    where: { id: review.debtId },
    data: {
      ...debtBalanceUpdate(review.debt, 0),
    },
  });
  await db.debtBalanceReview.delete({ where: { id: reviewId } });

  revalidateHousehold();
}

// Household says no, the real balance isn't $0 — the derived math was off
// (new charges the app can't see, an interest quirk, etc). Just clears the
// question; balanceCents was never written down by matchDebtPayments while
// this was pending, so it's still sitting at its last real value. The
// household corrects it by hand via the "Current Balance" field if needed
// (updateDebtBalance above) — same as before this feature existed.
export async function declineDebtBalancePaidOff(reviewId: string) {
  const session = await requireOwner();

  const review = await db.debtBalanceReview.findUnique({ where: { id: reviewId } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  await db.debtBalanceReview.delete({ where: { id: reviewId } });

  revalidateHousehold();
}

export async function dismissBnplSuggestion(key: string) {
  const session = await requireOwner();

  // update: { createdAt: new Date() } — not the default no-op — same reasoning
  // as dismissMinPaymentWarning / dismissNeedsSetupWarning below. detectUnlinkedBnpl
  // only suppresses a cluster whose transactions ALL predate the dismissal (so a
  // genuinely new plan on a coincidentally-similar key can still surface), which
  // means a dismissal made mid-cycle stops covering the cluster the moment the
  // next payment posts. Re-dismissing then hit `update: {}` and silently reused
  // the stale timestamp — the card reappeared on every refresh with no way to
  // clear it (real report, 2026-09-09: a closed Affirm plan dismissed Aug 17,
  // one more payment Aug 18, un-dismissable ever after).
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "BNPL", key } },
    create: { householdId: session.user.householdId, kind: "BNPL", key },
    update: { createdAt: new Date() },
  });
  // "No thanks" has to actually resolve the transactions behind it, not
  // just hide the card — see releaseBnplCluster's own comment for why an
  // unresolved cluster left sitting around is a real, not just cosmetic,
  // problem. Also fires (harmlessly) from the "Track as an installment
  // plan" path, which calls this same action right after createDebt — see
  // releaseBnplCluster's comment on why that ordering is safe.
  await releaseBnplCluster(session.user.householdId, key);
  // Rendered on /buckets now, not /debts (2026-08-16 move) — and the
  // dashboard's own AttentionLinkCard reads detectUnlinkedBnpl too.
  revalidateHousehold();
}

export async function dismissMinPaymentWarning(debtId: string) {
  const session = await requireOwner();

  const debt = await db.debt.findFirst({
    where: { id: debtId, householdId: session.user.householdId },
    select: { id: true, minPaymentCents: true, aprBasisPoints: true },
  });
  if (!debt) return;

  const key = minPaymentDismissKey(debt);
  // update: { createdAt: new Date() } — not the default no-op update — so
  // re-dismissing after the warning has already reappeared (see
  // getActiveInsufficientMinimumDebts's cycle-expiry check) resets the
  // snooze window to the new cycle instead of silently reusing the old
  // (already-stale) timestamp and reappearing again immediately.
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "MIN_PAYMENT_LOW", key } },
    create: { householdId: session.user.householdId, kind: "MIN_PAYMENT_LOW", key },
    update: { createdAt: new Date() },
  });
  revalidateHousehold();
}

export async function dismissNeedsSetupWarning(debtId: string) {
  const session = await requireOwner();

  const debt = await db.debt.findFirst({
    where: { id: debtId, householdId: session.user.householdId },
    select: {
      id: true,
      debtType: true,
      termsConfirmed: true,
      balanceCents: true,
      minPaymentCents: true,
      ignoreMinimumPayment: true,
    },
  });
  if (!debt) return;

  const [payment, pendingReview] = await Promise.all([
    db.debtPayment.findFirst({ where: { debtId, active: true }, select: { dueDateLocked: true } }),
    db.debtAmountReview.findFirst({ where: { debtPayment: { debtId } }, select: { id: true } }),
  ]);
  const reason = debtSetupReason(debt, payment?.dueDateLocked ?? null, Boolean(pendingReview));
  if (!reason) return; // already resolved between render and click — nothing to dismiss

  const key = debtSetupDismissKey(debtId, reason);
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "DEBT_NEEDS_SETUP", key } },
    create: { householdId: session.user.householdId, kind: "DEBT_NEEDS_SETUP", key },
    update: { createdAt: new Date() },
  });
  revalidateHousehold();
}

const payoffPlanSchema = z.object({
  order: z.enum(["AVALANCHE", "SNOWBALL", "CUSTOM"]),
  extra: z.string(),
  rollFreedMinimums: z.enum(["true", "false"]),
  rollFreedMinimumsSplit: z.enum(["true", "false"]),
  enabled: z.enum(["true", "false"]),
});

export type PayoffPlanState = { error?: string };

// Persists the payoff scenario (order/extra/roll-freed-minimums/enabled) on
// the Household — previously this was only ever a GET query param, so it
// reset to the hardcoded defaults on every visit instead of remembering the
// plan the household actually picked. rollFreedMinimums/enabled replaced
// the old PayoffMode/PayoffCalendarMode/payoffAnchorDate fields (2026-08-19)
// — the calendar mode and anchor date are gone entirely now that real
// paycheck dates are always derived from Income (see debt-payoff.ts).
export async function updateHouseholdPayoffPlan(
  _prev: PayoffPlanState,
  formData: FormData,
): Promise<PayoffPlanState> {
  const session = await requireOwner();

  const parsed = payoffPlanSchema.safeParse({
    order: formData.get("order"),
    extra: formData.get("extra"),
    rollFreedMinimums: formData.get("rollFreedMinimums"),
    rollFreedMinimumsSplit: formData.get("rollFreedMinimumsSplit"),
    enabled: formData.get("enabled"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // MoneyInput submits a formatted "$1,234.56" string — parseDollarsToCents
  // strips the $ and commas; Number() alone would NaN on it. A blank field
  // means $0 ("minimums only"), same as it did before.
  const extraCents = parsed.data.extra.trim() === "" ? 0 : parseDollarsToCents(parsed.data.extra);
  if (extraCents === null || extraCents < 0) {
    return { error: "Enter a valid extra payment amount." };
  }

  await db.household.update({
    where: { id: session.user.householdId },
    data: {
      payoffOrder: parsed.data.order,
      payoffExtraCents: extraCents,
      payoffRollFreedMinimums: parsed.data.rollFreedMinimums === "true",
      payoffRollFreedMinimumsSplit: parsed.data.rollFreedMinimumsSplit === "true",
      payoffPlanEnabled: parsed.data.enabled === "true",
    },
  });

  revalidateHousehold();
  return {};
}

// Takes the full new attack order (from PayoffPlanner's dnd-kit drag-drop),
// crystallizes it as explicit sortOrder values, and switches the household
// to CUSTOM — same "a manual edit always wins" convention used elsewhere
// (see reassignTransaction). Picking AVALANCHE/SNOWBALL again from the
// strategy form abandons the custom order. Replaces the old moveDebtOrder
// (single up/down neighbor swap, 2026-08-10) now that dnd-kit hands back a
// full reordered list on every drop instead of one step at a time.
// `orderedActiveDebtIds` only needs to cover active/included debts — the
// ones actually draggable in the UI; paid-off/excluded debts are appended
// server-side, trailing, in their existing relative order, same as before.
export async function setDebtPayoffOrder(orderedActiveDebtIds: string[]) {
  const session = await requireOwner();

  const debts = await db.debt.findMany({
    where: { householdId: session.user.householdId },
    orderBy: { sortOrder: "asc" },
  });

  const activeIdSet = new Set(orderedActiveDebtIds);
  const allDebtIds = new Set(debts.map((d) => d.id));
  // Only trust ids this household actually owns and that were part of the
  // draggable (active/included) set — anything else is dropped rather than
  // trusted, same defensive posture as other id-list-taking actions.
  const validOrderedIds = orderedActiveDebtIds.filter((id) => allDebtIds.has(id));
  const trailing = debts.filter((d) => !activeIdSet.has(d.id)).map((d) => d.id);
  const displayOrder = [...validOrderedIds, ...trailing];
  if (displayOrder.length === 0) return;

  await db.$transaction([
    ...displayOrder.map((id, i) => db.debt.update({ where: { id }, data: { sortOrder: i } })),
    db.household.update({ where: { id: session.user.householdId }, data: { payoffOrder: "CUSTOM" } }),
  ]);

  revalidateHousehold();
}

// Same simple toggle shape as setAccountBudgetTracked
// (settings/accounts/actions.ts) — flips Debt.includeInPayoffPlan, which
// debts/page.tsx reads to decide whether a debt participates in
// simulatePayoff/computeAttackOrder (see the payoffEligibleDebtInputs split
// there) or just sits listed with its balance, excluded. Any debt, not just
// BNPL — a household may want to exclude any plan (e.g. a fully deferred
// 0%-interest promo) from the debt-free-date math without deleting it.
export async function setDebtIncludedInPayoffPlan(debtId: string, included: boolean) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  await db.debt.update({ where: { id: debtId }, data: { includeInPayoffPlan: included } });
  revalidateHousehold();
}

// The "not this one" half of the extra-payment to-do list. Only ever offered for a
// "pending" line (this cycle's own payday, per projectCyclePlan's
// past-payday branch in src/lib/debt-payoff.ts) — that payday's extra is
// otherwise assumed to go through on schedule, same as any future payday
// (household correction, 2026-09-04: "yesterday's still going through");
// this is the one way to forfeit it instead, and it can't retroactively
// un-apply a real posted payment. simulatePayoff (the projected debt-free
// date/chart) is unaffected — it only ever counts a future payday's extra,
// so a skip on the current cycle's own payday was never counted there.
// Upsert makes a double "skip" click idempotent —
// @@unique([debtId, paycheckDate]) on the model does the rest (a new
// paycheck date always starts unskipped).
// amountCents/isPayoff: exactly what the household saw on the "Skip this
// extra payment?" confirm, frozen at skip time — see the schema comment on
// PayoffExtraSkip.amountCents for why this can't just be re-derived live
// later (projectCyclePlan redoes the whole simulation from today's debt
// roster/priority order every time, which drifts once that roster changes).
export async function skipPayoffExtra(debtId: string, paycheckDateISO: string, amountCents: number, isPayoff: boolean) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  const paycheckDate = new Date(paycheckDateISO);
  await db.payoffExtraSkip.upsert({
    where: { debtId_paycheckDate: { debtId, paycheckDate } },
    create: { householdId: session.user.householdId, debtId, paycheckDate, amountCents, isPayoff },
    update: { amountCents, isPayoff },
  });
  revalidateHousehold();
}

// Undoes a mis-click on skipPayoffExtra above.
export async function unskipPayoffExtra(debtId: string, paycheckDateISO: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  // Undo is only offered until the skipped payday passes (household rule,
  // 2026-09-20) — mirrored here so a stale tab can't reverse it afterward.
  if (paycheckDateISO < todayAsUTCDate().toISOString().slice(0, 10)) return;

  await db.payoffExtraSkip
    .delete({ where: { debtId_paycheckDate: { debtId, paycheckDate: new Date(paycheckDateISO) } } })
    .catch(() => {}); // already unskipped — nothing to do
  revalidateHousehold();
}

// The "skip it" half of a *covered* minimum — a payment bigger than the
// minimum, made ahead of its due date, already satisfied the cycle (see
// DebtMinimumSkip's schema comment and resolveMinimumLedger). Display-only:
// nothing rolls into amountDueCents either way. Refuses when the cycle's
// minimum isn't actually satisfied (the row wouldn't be offered in the UI,
// but a stale tab or a hand-built call must not be able to forfeit a real
// owed minimum) — checked against the same DebtPayment.amountDueCents that
// drives the rolling balance. amountCents is what the household saw, frozen.
export async function skipDebtMinimum(debtId: string, dueDateISO: string, amountCents: number) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId }, include: { debtPayment: { select: { amountDueCents: true } } } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;
  if (!debt.debtPayment || debt.debtPayment.amountDueCents > 0) return;

  const dueDate = new Date(dueDateISO);
  await db.debtMinimumSkip.upsert({
    where: { debtId_dueDate: { debtId, dueDate } },
    create: { householdId: session.user.householdId, debtId, dueDate, amountCents },
    update: { amountCents },
  });
  revalidateHousehold();
}

// Undoes a mis-click on skipDebtMinimum above.
export async function unskipDebtMinimum(debtId: string, dueDateISO: string) {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId)) return;

  // Same window as unskipPayoffExtra: Undo only until the due date passes.
  if (dueDateISO < todayAsUTCDate().toISOString().slice(0, 10)) return;

  await db.debtMinimumSkip
    .delete({ where: { debtId_dueDate: { debtId, dueDate: new Date(dueDateISO) } } })
    .catch(() => {}); // already unskipped — nothing to do
  revalidateHousehold();
}

// Points a specific debt-payment transaction at one of the already-bucketed
// purchases it's paying off — see the schema comment on
// Transaction.accountedForLinks — so getBucketsWithProgress
// (src/lib/buckets.ts) can exclude the purchase's own net amount from the
// debt's bucket total instead of double-counting it. A payment can be linked
// to more than one purchase (e.g. two same-day trips settled by one card
// payment) — calling this again with a different purchaseTransactionId adds
// a second link rather than replacing the first. Also clears
// notAccountedFor, in case a household is changing their mind from an
// earlier "no" answer.
export async function linkPaymentAccountedFor(paymentTransactionId: string, purchaseTransactionId: string) {
  const session = await requireOwner();

  const [payment, purchase] = await Promise.all([
    db.transaction.findUnique({ where: { id: paymentTransactionId }, include: { debtPayment: { select: { bucketId: true } } } }),
    db.transaction.findUnique({ where: { id: purchaseTransactionId } }),
  ]);
  if (!belongsToHousehold(payment, session.user.householdId)) return;
  if (!belongsToHousehold(purchase, session.user.householdId)) return;
  if (!payment.debtPaymentId) return;
  if (!purchase.bucketId) return;

  await db.$transaction([
    db.transaction.update({ where: { id: paymentTransactionId }, data: { notAccountedFor: false } }),
    // upsert, not create: re-picking the same purchase (a double-tap, or two
    // browser tabs) is a harmless no-op, not a unique-constraint error.
    db.debtPaymentAccountedFor.upsert({
      where: { paymentTransactionId_purchaseTransactionId: { paymentTransactionId, purchaseTransactionId } },
      create: { paymentTransactionId, purchaseTransactionId },
      update: {},
    }),
  ]);
  revalidateHousehold();
}

// The "X" on one linked purchase's "Reimbursed by X"-style ledger line
// (DebtPaymentRow) — removes just that one match, leaving any others on the
// same payment untouched. The payment reverts to undecided only once its
// last link is removed (see DebtPaymentRow's own `decided` logic).
export async function unlinkPaymentAccountedFor(paymentTransactionId: string, purchaseTransactionId: string) {
  const session = await requireOwner();

  const payment = await db.transaction.findUnique({
    where: { id: paymentTransactionId },
    include: { debtPayment: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(payment, session.user.householdId)) return;

  await db.debtPaymentAccountedFor.deleteMany({ where: { paymentTransactionId, purchaseTransactionId } });
  revalidateHousehold();
}

// The explicit "no, just a payment" answer (Transaction.notAccountedFor) —
// the other resolution to the same question linkPaymentAccountedFor answers
// "yes" to. Also clears every existing accountedForLinks row defensively,
// though the UI never offers both states as live options at once.
export async function markPaymentNotAccountedFor(paymentTransactionId: string) {
  const session = await requireOwner();

  const payment = await db.transaction.findUnique({
    where: { id: paymentTransactionId },
    include: { debtPayment: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(payment, session.user.householdId)) return;
  if (!payment.debtPaymentId) return;

  await db.$transaction([
    db.transaction.update({ where: { id: paymentTransactionId }, data: { notAccountedFor: true } }),
    db.debtPaymentAccountedFor.deleteMany({ where: { paymentTransactionId } }),
  ]);
  revalidateHousehold();
}

// The "X" on a declined payment's "Just a payment" ledger line
// (DebtPaymentRow) — reverts back to undecided, same as
// unlinkPaymentAccountedFor does for the "yes" side.
export async function unmarkPaymentNotAccountedFor(paymentTransactionId: string) {
  const session = await requireOwner();

  const payment = await db.transaction.findUnique({
    where: { id: paymentTransactionId },
    include: { debtPayment: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(payment, session.user.householdId)) return;

  await db.transaction.update({ where: { id: paymentTransactionId }, data: { notAccountedFor: false } });
  revalidateHousehold();
}

// CARD/LOAN recategorization for an existing REVOLVING debt — see DebtKind's
// doc comment in schema.prisma. No-op for INSTALLMENT (always BNPL,
// unconditionally, from createDebt) since there's no UI path to call this
// for one anyway.
export async function updateDebtKind(debtId: string, kind: "CARD" | "LOAN") {
  const session = await requireOwner();

  const debt = await db.debt.findUnique({ where: { id: debtId } });
  if (!belongsToHousehold(debt, session.user.householdId) || debt.debtType !== "REVOLVING") return;

  await db.debt.update({ where: { id: debtId }, data: { kind } });
  revalidateHousehold();
}
