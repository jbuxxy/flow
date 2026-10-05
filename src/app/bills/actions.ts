"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveCategoryId } from "@/lib/bill-category-resolve";
import { belongsToHousehold, requireFullAccess } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import {
  nextBillDueDate,
  attachTransactionAsExtraCharge,
  attachTransactionAsBillPayment,
  isBillCycleSkipActive,
} from "@/lib/recurring-bills";
import { upsertMerchantRule } from "@/lib/merchant-rules";
import { currentMonthOccurrenceOfDay, nextOccurrenceOfDay } from "@/lib/date";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { suggestCategoryForMerchant } from "@/lib/ai";

const cadenceEnum = z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "ANNUAL"]);

// A monthly bill's due date only needs a day-of-month (see
// nextOccurrenceOfDay's doc comment, src/lib/date.ts) — but cadence here is
// genuinely user-editable (weekly/biweekly/annual bills are real, unlike a
// REVOLVING debt payment), so the day picker only replaces the full date
// one when cadence is MONTHLY; nextDueDate still carries a real date for
// the other cadences.
function parseDueDay(dueDay: string): number | null {
  const day = Number(dueDay);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

const billSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.string(),
  // Blank means "use the default 30%/$5-floor heuristic" (see
  // amountToleranceCents) — only stored as a real override when the
  // household deliberately types one in.
  tolerance: z.string().optional(),
  cadence: cadenceEnum,
  categoryId: z.string().min(1),
  dueDay: z.string().optional(),
  nextDueDate: z.string().optional(),
  bucketId: z.string().optional(),
});

function parseOptionalToleranceCents(tolerance: string | undefined): { ok: true; value: number | null } | { ok: false } {
  if (!tolerance) return { ok: true, value: null };
  const cents = parseDollarsToCents(tolerance);
  if (cents === null || cents < 0) return { ok: false };
  return { ok: true, value: cents };
}

export type BillFormState = { error?: string };

async function resolveBucketId(householdId: string, bucketId?: string): Promise<string | null> {
  if (!bucketId) return null;
  const bucket = await db.bucket.findUnique({ where: { id: bucketId } });
  return bucket && bucket.householdId === householdId ? bucket.id : null;
}

export async function updateBill(
  billId: string,
  _prev: BillFormState,
  formData: FormData,
): Promise<BillFormState> {
  const session = await requireFullAccess();

  const bill = await db.recurringBill.findUnique({ where: { id: billId } });
  if (!belongsToHousehold(bill, session.user.householdId)) return { error: "Not found." };

  const parsed = billSchema.safeParse({
    name: formData.get("name"),
    amount: formData.get("amount"),
    tolerance: formData.get("tolerance") || undefined,
    cadence: formData.get("cadence"),
    categoryId: formData.get("categoryId"),
    dueDay: formData.get("dueDay") || undefined,
    nextDueDate: formData.get("nextDueDate") || undefined,
    bucketId: formData.get("bucketId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) return { error: "Enter a valid amount." };

  const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
  if (!tolerance.ok) return { error: "Enter a valid tolerance." };

  let nextDueDate: Date;
  if (parsed.data.cadence === "MONTHLY") {
    const day = parsed.data.dueDay ? parseDueDay(parsed.data.dueDay) : null;
    if (day === null) return { error: "Enter a valid due date." };
    nextDueDate = nextOccurrenceOfDay(day);
    // Confirming the due date must not roll past an unpaid current cycle. If
    // this bill has real payment history but nothing yet this period, and
    // the chosen day has already gone by this month, nextOccurrenceOfDay
    // lands in *next* month — skipping the now-overdue cycle, hiding the
    // bill from every "this month" surface, and making BillRow read "Paid
    // <stale date>" off its future-month heuristic (2026-08-30 incident:
    // Fairview Water Improvement District / Summit Gas). Keep it on this
    // month's occurrence. A never-paid bill keeps the forward roll — its
    // first due date is legitimately upcoming (cf. the same-day
    // future-first-due-date debt fix).
    const { start: periodStart } = utcPeriodBounds(currentPeriodKey());
    const paidThisPeriod = bill.lastPaidDate !== null && bill.lastPaidDate >= periodStart;
    if (bill.lastPaidDate !== null && !paidThisPeriod) {
      const thisMonth = currentMonthOccurrenceOfDay(day);
      if (nextDueDate > thisMonth) nextDueDate = thisMonth;
    }
  } else {
    nextDueDate = new Date(parsed.data.nextDueDate ?? "");
    if (Number.isNaN(nextDueDate.getTime())) return { error: "Enter a valid due date." };
  }

  const resolvedBucketId = await resolveBucketId(session.user.householdId, parsed.data.bucketId);
  const resolvedCategoryId = await resolveCategoryId(session.user.householdId, parsed.data.categoryId, resolvedBucketId);

  await db.recurringBill.update({
    where: { id: billId },
    data: {
      name: parsed.data.name,
      amountCents,
      toleranceCents: tolerance.value,
      cadence: parsed.data.cadence,
      categoryId: resolvedCategoryId,
      nextDueDate,
      // The form's nextDueDate field is always submitted, so saving it is
      // itself the confirmation — even if the value happens not to have
      // changed from the app's own approximate guess.
      dueDateLocked: true,
      bucketId: resolvedBucketId,
    },
  });

  // A bill's linked payments always follow the bill's bucket + category
  // (2026-08-27 household rule) — every payment, not just the still-
  // uncategorized ones, so editing the bill is the single lever that fixes
  // its whole history (a payment auto-filed elsewhere before the bill was
  // set up included).
  if (resolvedBucketId) {
    await db.transaction.updateMany({
      where: { householdId: session.user.householdId, billId },
      data: {
        bucketId: resolvedBucketId,
        categoryId: resolvedCategoryId,
        aiSuggestedBucketId: null,
        aiSuggestedCategoryId: null,
      },
    });
    if (bill.merchant) {
      await upsertMerchantRule(
        session.user.householdId,
        bill.merchant,
        { bucketId: resolvedBucketId, debtId: null, categoryId: resolvedCategoryId, isTransfer: false, isIncome: false },
        { confidence: 1, source: "USER" },
      );
    }
  }

  revalidatePath("/");
  revalidatePath("/buckets");
  if (resolvedBucketId) revalidatePath(`/buckets/${resolvedBucketId}`);
  return {};
}

// Advances nextDueDate to the next occurrence with no matching payment —
// for a cycle the household genuinely expects to owe nothing on (a bill
// that readjusts and left a credit/surplus that cycle, household report
// 2026-08-26), which otherwise looks identical to a missed payment: with no
// transaction ever matching, nextDueDate just sits there and dueStatus
// (bill-row.tsx) renders it "Overdue by N days," growing forever, with
// nothing to distinguish "skipped on purpose" from "actually forgot this
// one." Deliberately leaves lastPaidDate untouched — this cycle wasn't
// paid, so it shouldn't earn the green "Paid" checkmark either, it should
// just stop being counted as due. Also records a BillCycleSkip row (the due
// date being skipped, captured before it advances) so BillRow can keep
// showing "Skipped {date}" with an Undo for the rest of this cycle instead
// of the row just silently becoming an ordinary upcoming bill — see that
// model's own schema comment. No longer gated behind a days-overdue wait:
// the household can know for certain ahead of the due date (a credit
// balance, household report 2026-09-14: Summit Gas, days before it was even
// due) — BillRow now offers this from the kebab any time the cycle isn't
// already paid or already skipped, not just once it's sat overdue a while.
export async function skipBillCycle(billId: string) {
  const session = await requireFullAccess();

  const bill = await db.recurringBill.findUnique({ where: { id: billId } });
  if (!belongsToHousehold(bill, session.user.householdId)) return;

  const cycleDueDate = bill.nextDueDate;
  await db.$transaction([
    db.billCycleSkip.upsert({
      where: { billId_cycleDueDate: { billId, cycleDueDate } },
      create: { householdId: session.user.householdId, billId, cycleDueDate },
      update: {},
    }),
    db.recurringBill.update({
      where: { id: billId },
      data: { nextDueDate: nextBillDueDate(bill.cadence, cycleDueDate, []) },
    }),
  ]);
  revalidatePath("/");
  if (bill.bucketId) revalidatePath(`/buckets/${bill.bucketId}`);
}

// Undoes a skip from skipBillCycle above — a change of mind, or the
// household discovers something actually is owed after all. Reverses both
// halves together: deletes the BillCycleSkip row and moves nextDueDate back
// to the cycle that got skipped, so the bill returns to exactly its
// pre-skip state. Only acts while this is still the bill's *active* skip —
// nothing has paid or rolled the cycle over again since (same check
// getActiveBillCycleSkips uses to decide whether to show it in the first
// place) — so a stale/already-superseded skip can't be resurrected by an
// Undo click that raced a real payment landing in between.
export async function unskipBillCycle(billId: string) {
  const session = await requireFullAccess();

  const bill = await db.recurringBill.findUnique({ where: { id: billId } });
  if (!belongsToHousehold(bill, session.user.householdId)) return;

  const skip = await db.billCycleSkip.findFirst({ where: { billId }, orderBy: { skippedAt: "desc" } });
  if (!skip || !isBillCycleSkipActive(bill.cadence, skip.cycleDueDate, bill.nextDueDate)) return;

  await db.$transaction([
    db.billCycleSkip.delete({ where: { id: skip.id } }),
    db.recurringBill.update({ where: { id: billId }, data: { nextDueDate: skip.cycleDueDate } }),
  ]);
  revalidatePath("/");
  if (bill.bucketId) revalidatePath(`/buckets/${bill.bucketId}`);
}

// "Cancel" on a bill row. A bill with no payment *this calendar month* is a
// clean hard-delete — nothing about the current month depends on it, and
// wiping the RecurringBill row keeps the merchant eligible for
// re-suggestion the moment charges resume (detectMerchantBillSuggestions
// keys its exclusion on "does a row exist"). But a bill already paid this
// month is real money out; cancelling it must not erase it from this
// month's recurring lists / Recurring Total / week card. Soft-delete
// (active:false) so currentPeriodBillWhere keeps surfacing it, settled and
// read-only, until the month rolls over and it drops out on its own.
// Payment date, not due date (matches currentPeriodBillWhere): a sub
// charged last month is last month's, cancel it clean. Linked transactions
// are untouched either way (billId clears via onDelete: SetNull on a hard
// delete; nothing moves on a soft one).
export async function deleteBill(billId: string) {
  const session = await requireFullAccess();

  const bill = await db.recurringBill.findUnique({ where: { id: billId } });
  if (!belongsToHousehold(bill, session.user.householdId)) return;

  const { start: periodStart } = utcPeriodBounds(currentPeriodKey());
  const paidThisPeriod = bill.lastPaidDate !== null && bill.lastPaidDate >= periodStart;

  if (paidThisPeriod) {
    await db.recurringBill.update({ where: { id: billId }, data: { active: false } });
  } else {
    await db.recurringBill.delete({ where: { id: billId } });
  }

  revalidatePath("/");
  revalidatePath("/bills");
  if (bill.bucketId) revalidatePath(`/buckets/${bill.bucketId}`);
}

const createBillFromTransactionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.string(),
  tolerance: z.string().optional(),
  cadence: cadenceEnum,
  categoryId: z.string().optional(),
  // Only needed when the transaction isn't already sitting on a bucket page
  // (e.g. tracked from /transactions or the "Needs a bucket" queue) — see
  // the bucketId resolution below.
  bucketId: z.string().optional(),
});

// Turns *any* already-bucketed transaction into a tracked RecurringBill —
// the general-purpose counterpart to detectMerchantBillSuggestions, for a
// bill whose pattern the auto-detector never caught (too few occurrences
// so far, an irregular amount, or a merchant string that varies). The
// household supplies amount/tolerance/cadence themselves instead of the
// detector inferring them, so this works on literally any debit, tracked
// or not, matched or not. The debt-payment counterpart (tracking a
// transaction as a card/loan's recurring payment instead) is
// createDebtPaymentFromTransaction in src/app/debts/actions.ts.
export async function createBillFromTransaction(
  transactionId: string,
  _prev: BillFormState,
  formData: FormData,
): Promise<BillFormState> {
  const session = await requireFullAccess();

  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { account: { select: { budgetTracked: true } } },
  });
  if (!belongsToHousehold(transaction, session.user.householdId)) return { error: "Not found." };
  if (transaction.billId) return { error: "Already tracked as a bill." };
  // Same rule as reassignTransaction's bucket branch (src/app/buckets/actions.ts)
  // — a bill always carries a bucketId, which a non-budget-tracked account's
  // spend (see Account.budgetTracked) must never get.
  if (transaction.account && !transaction.account.budgetTracked) {
    return { error: "This account isn't used for budgeting — track it as a debt payment or income instead." };
  }

  const parsed = createBillFromTransactionSchema.safeParse({
    name: formData.get("name"),
    amount: formData.get("amount"),
    tolerance: formData.get("tolerance") || undefined,
    cadence: formData.get("cadence"),
    categoryId: formData.get("categoryId") || undefined,
    bucketId: formData.get("bucketId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) return { error: "Enter a valid amount." };

  const tolerance = parseOptionalToleranceCents(parsed.data.tolerance);
  if (!tolerance.ok) return { error: "Enter a valid tolerance." };

  // A bucket-page transaction already has one (used as-is, same as before);
  // one tracked from a bucket-agnostic view (/transactions, "Needs a
  // bucket") supplies it via the form's bucket picker instead — a
  // RecurringBill with no bucket at all would never appear anywhere (every
  // bucket page only ever queries its own bills).
  const targetBucketId = transaction.bucketId ?? parsed.data.bucketId ?? null;
  if (!targetBucketId) return { error: "Pick a bucket." };
  if (!transaction.bucketId) {
    const bucket = await db.bucket.findFirst({ where: { id: targetBucketId, householdId: session.user.householdId } });
    if (!bucket) return { error: "Bucket not found." };
  }

  const resolvedCategoryId = await resolveCategoryId(session.user.householdId, parsed.data.categoryId, targetBucketId);

  const bill = await db.recurringBill.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      merchant: transaction.merchant.trim().toLowerCase(),
      amountCents,
      toleranceCents: tolerance.value,
      cadence: parsed.data.cadence,
      categoryId: resolvedCategoryId,
      // Projects one cadence forward from this transaction's own date —
      // it already happened, so it's the most recent real anchor point.
      nextDueDate: nextBillDueDate(parsed.data.cadence, transaction.occurredOn, [transaction.occurredOn]),
      lastPaidDate: transaction.occurredOn,
      bucketId: targetBucketId,
    },
  });

  // The bill's payment always carries the bill's own bucket + category
  // (2026-08-27 household rule) — overriding whatever the transaction was
  // filed under before it was tracked as a bill.
  await db.transaction.update({
    where: { id: transactionId },
    data: {
      billId: bill.id,
      bucketId: targetBucketId,
      categoryId: resolvedCategoryId,
      aiSuggestedBucketId: null,
      aiSuggestedCategoryId: null,
    },
  });

  if (bill.bucketId) {
    await upsertMerchantRule(
      session.user.householdId,
      transaction.merchant,
      { bucketId: bill.bucketId, debtId: null, categoryId: resolvedCategoryId, isTransfer: false, isIncome: false },
      { confidence: 1, source: "USER" },
    );
  }

  revalidatePath("/");
  revalidatePath("/buckets");
  revalidatePath("/transactions");
  revalidatePath(`/buckets/${bill.bucketId}`);
  if (transaction.bucketId && transaction.bucketId !== bill.bucketId) revalidatePath(`/buckets/${transaction.bucketId}`);
  return {};
}

// Accepts a merchant-detected bill suggestion (see detectMerchantBillSuggestions
// in bill-detect.ts). The debt-payment counterpart is
// acceptDebtPaymentSuggestion in src/app/debts/actions.ts.
export async function acceptBillSuggestion(
  key: string,
  merchant: string,
  amountCents: number,
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL",
  categoryId: string | null,
  nextDueDate: string,
  transactionIds: string[],
  bucketId: string | null,
) {
  const session = await requireFullAccess();

  const resolvedBucketId = await resolveBucketId(session.user.householdId, bucketId ?? undefined);
  const resolvedCategoryId = await resolveCategoryId(session.user.householdId, categoryId, resolvedBucketId);

  // lastPaidDate must be the most recent *actual* occurrence this suggestion
  // was detected from, not the moment the user clicks "Track it" — otherwise
  // every newly-tracked bill looks paid "this week" on the dashboard
  // regardless of its real due date (see getBillsThisWeek's lastPaidDate
  // OR-clause), even ones next due months from now.
  const mostRecent = await db.transaction.findFirst({
    where: { id: { in: transactionIds }, householdId: session.user.householdId },
    orderBy: { occurredOn: "desc" },
    select: { occurredOn: true },
  });

  const bill = await db.recurringBill.create({
    data: {
      householdId: session.user.householdId,
      name: merchant,
      merchant: merchant.trim().toLowerCase(),
      amountCents,
      cadence,
      categoryId: resolvedCategoryId,
      nextDueDate: new Date(nextDueDate),
      lastPaidDate: mostRecent?.occurredOn ?? null,
      bucketId: resolvedBucketId,
    },
  });
  // billId is additive (a bill's transaction is still normal bucketed
  // spend), but this bucket isn't implied by anything upstream —
  // detectMerchantBillSuggestions groups by merchant alone, regardless of
  // whether those transactions ever got bucketed. So track it here: apply
  // the chosen bucket to the whole history that led to this suggestion (not
  // just the ones still uncategorized — a bill's cycle should read as one
  // consistent bucket), and remember it as a merchant rule so future
  // occurrences bucket themselves at the next sync without waiting on
  // matchBillPayments.
  await db.transaction.updateMany({
    where: { id: { in: transactionIds }, householdId: session.user.householdId },
    data: {
      billId: bill.id,
      ...(resolvedBucketId
        ? { bucketId: resolvedBucketId, categoryId: resolvedCategoryId, aiSuggestedBucketId: null, aiSuggestedCategoryId: null }
        : {}),
    },
  });
  if (resolvedBucketId) {
    await upsertMerchantRule(
      session.user.householdId,
      merchant,
      { bucketId: resolvedBucketId, debtId: null, categoryId: resolvedCategoryId, isTransfer: false, isIncome: false },
      { confidence: 1, source: "USER" },
    );
  }
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "BILL", key } },
    create: { householdId: session.user.householdId, kind: "BILL", key },
    update: {},
  });

  revalidatePath("/");
  revalidatePath("/buckets");
  if (resolvedBucketId) revalidatePath(`/buckets/${resolvedBucketId}`);
}

// Which bucket/debt page a dismissed suggestion was showing on isn't known
// cheaply here (the key alone doesn't say) — "layout" revalidates every
// /buckets/[id] page in one call rather than guessing which one.
export async function dismissBillSuggestion(key: string) {
  const session = await requireFullAccess();

  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "BILL", key } },
    create: { householdId: session.user.householdId, kind: "BILL", key },
    update: {},
  });
  revalidatePath("/buckets", "layout");
  revalidatePath("/debts");
  revalidatePath("/");
}

const categoryNameSchema = z.string().trim().min(1).max(40);

export type CreateCategoryResult = { error?: string; category?: { id: string; name: string } };

// Fully household-managed — a household can add whatever categories are
// actually useful to them ("Card payment" alongside "Loan payment") without
// waiting on a release. Called directly from the category picker's "New
// category" modal, not through a <form action>, so the newly created
// category can be selected immediately in the same click.
// bucketId is required now (2026-08-23 — categories became bucket-scoped,
// see the schema comment on BillCategory.bucketId) — every category belongs
// to exactly one bucket's own picker, so there's always a specific bucket in
// scope wherever this is called from (CategoryPicker always knows which
// bucket it's currently offering categories for).
export async function createBillCategory(bucketId: string, name: string): Promise<CreateCategoryResult> {
  const session = await requireFullAccess();

  const bucket = await db.bucket.findUnique({ where: { id: bucketId } });
  if (!belongsToHousehold(bucket, session.user.householdId)) return { error: "Bucket not found." };

  const nameParsed = categoryNameSchema.safeParse(name);
  if (!nameParsed.success) return { error: "Enter a name." };

  const existing = await db.billCategory.findUnique({
    where: { bucketId_name: { bucketId, name: nameParsed.data } },
  });
  if (existing) return { error: "That category already exists." };

  const category = await db.billCategory.create({
    data: { householdId: session.user.householdId, bucketId, name: nameParsed.data },
  });

  revalidatePath("/buckets", "layout");
  revalidatePath("/debts");
  return { category: { id: category.id, name: category.name } };
}

export type UpdateCategoryResult = { error?: string };

// A rename, not a re-create — every bill/debt payment/transaction/pattern/
// merchant rule already pointing at this category's id keeps pointing at it
// (categoryId is never touched), so renaming "Fast Food" to "Quick Service"
// just changes the label everywhere it already shows, with nothing to
// re-link. Called from the household's category manager (bucket settings —
// src/app/buckets/[id]/category-manager.tsx), reusing the same
// categoryNameSchema validation createBillCategory uses.
export async function updateBillCategory(categoryId: string, name: string): Promise<UpdateCategoryResult> {
  const session = await requireFullAccess();

  const category = await db.billCategory.findUnique({ where: { id: categoryId } });
  if (!belongsToHousehold(category, session.user.householdId)) return { error: "Not found." };

  const nameParsed = categoryNameSchema.safeParse(name);
  if (!nameParsed.success) return { error: "Enter a name." };

  // findFirst, not findUnique — category.bucketId can be null for a
  // pre-existing orphaned category (Prisma's generated findUnique compound
  // key for bucketId_name requires a non-null bucketId, since Postgres
  // treats every NULL as distinct for uniqueness purposes anyway).
  const existing = await db.billCategory.findFirst({
    where: { bucketId: category.bucketId, name: nameParsed.data },
  });
  if (existing && existing.id !== categoryId) return { error: "That category already exists." };

  await db.billCategory.update({ where: { id: categoryId }, data: { name: nameParsed.data } });

  revalidatePath("/buckets", "layout");
  revalidatePath("/debts");
  revalidatePath("/transactions");
  revalidatePath("/income");
  return {};
}

export type CategorySuggestionResult = { error?: string; categoryId?: string | null; newCategoryName?: string | null };

// Called on-demand from TrackAsBillForm's "Suggest" button — see the doc
// comment on suggestCategoryForMerchant (src/lib/ai.ts) for why this isn't
// batched/automatic like the transaction-bucket AI suggestions.
// bucketId scopes the candidate list to that bucket's own categories (see
// the schema comment on BillCategory.bucketId) — without it (no bucket
// picked yet in the caller's form) this falls back to the full household
// list, which the caller then has to reject anyway if it lands outside
// whatever bucket eventually gets chosen (see resolveCategoryId's own
// bucket check) — better to just scope it correctly when we can.
export async function suggestBillCategory(merchant: string, bucketId?: string | null): Promise<CategorySuggestionResult> {
  const session = await requireFullAccess();

  const categories = await db.billCategory.findMany({
    where: bucketId
      ? { bucketId, householdId: session.user.householdId }
      : { householdId: session.user.householdId },
    select: { id: true, name: true },
  });
  const suggestion = await suggestCategoryForMerchant(session.user.householdId, merchant, categories);
  if (!suggestion) return { error: "No AI provider configured for this household." };
  return suggestion;
}

// Doesn't touch any bill that was using it — onDelete: SetNull just clears
// categoryId back to null (shown as "Uncategorized"), same "removing a
// label never destroys the thing it labeled" convention as untracking a
// bill.
export async function deleteBillCategory(categoryId: string) {
  const session = await requireFullAccess();

  const category = await db.billCategory.findUnique({ where: { id: categoryId } });
  if (!belongsToHousehold(category, session.user.householdId)) return;

  await db.billCategory.delete({ where: { id: categoryId } });
  revalidatePath("/buckets", "layout");
  revalidatePath("/debts");
}

export async function dismissBillNeedsDueDateWarning(billId: string) {
  const session = await requireFullAccess();

  const bill = await db.recurringBill.findFirst({
    where: { id: billId, householdId: session.user.householdId },
    select: { id: true },
  });
  if (!bill) return;

  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "BILL_NEEDS_DUE_DATE", key: billId } },
    create: { householdId: session.user.householdId, kind: "BILL_NEEDS_DUE_DATE", key: billId },
    update: { createdAt: new Date() },
  });
  revalidatePath("/buckets", "layout");
  revalidatePath("/");
}

// A second real charge belonging to a bill's payment that matchBillPayments
// could never claim on its own — a bank fee riding alongside the real bill
// charge as its own separate transaction (Cedar Creek Irrigation: a $35 payment +
// its own $2 "online bill pay" convenience fee, posted as two debits).
// Every transaction *within* a bill's own amount tolerance is already
// auto-claimed before a household ever reaches the "track as..." picker (see
// TrackAsBillForm's doc comment on why it never lists an existing bill as a
// target) — this exists specifically for the leftover leg that will never
// match on amount but genuinely belongs to the bill, and — since a RECURRING
// bucket only ever accepts a real bill payment (see Bucket.trackingMode) —
// has no other legal way to land in the bill's own bucket. Deliberately
// does not touch the bill's lastPaidDate/nextDueDate/amountCents (those stay
// driven by matchBillPayments' own "official" cycle payment); this transaction
// just joins the current cycle's payments list as an "extra" (bill-row.tsx),
// the same way a genuine second same-cycle charge already does.
//
// Also teaches a BillExtraChargeRule for this merchant/amount (2026-09-14
// household request) — matchBillPayments re-applies it automatically every
// future cycle from here on, tightly bound to both the merchant text and
// this confirmed amount, so a household only has to do this by hand once
// per recurring ancillary fee, not every cycle.
export async function attachExtraBillCharge(
  transactionId: string,
  billId: string,
): Promise<{ error?: string }> {
  const session = await requireFullAccess();

  const [transaction, bill] = await Promise.all([
    db.transaction.findUnique({ where: { id: transactionId } }),
    db.recurringBill.findUnique({ where: { id: billId } }),
  ]);
  if (!belongsToHousehold(transaction, session.user.householdId)) return { error: "Charge not found." };
  if (!belongsToHousehold(bill, session.user.householdId)) return { error: "Bill not found." };
  if (transaction.billId) return { error: "That charge is already linked to a bill." };
  if (transaction.amountCents <= 0) return { error: "Only a debit can be attached to a bill." };

  await attachTransactionAsExtraCharge(transactionId, bill);

  // Learn it: the next occurrence of this same merchant/amount (a household
  // confirmed, 2026-09-14, that a bill's ancillary fee lands the same real
  // day as its own main charge every cycle) now auto-attaches on its own —
  // matchBillPayments (recurring-bills.ts) re-applies this every sync,
  // tightly bound to both the merchant text and this exact amount (see
  // extraChargeToleranceCents) so an unrelated same-descriptor charge is
  // never swept in. Upsert, not create — re-confirming the same merchant
  // for this bill (the amount drifted a few cents, say) just refreshes it
  // rather than erroring on the unique (billId, merchant) constraint.
  await db.billExtraChargeRule.upsert({
    where: { billId_merchant: { billId: bill.id, merchant: transaction.merchant.trim().toLowerCase() } },
    create: {
      householdId: session.user.householdId,
      billId: bill.id,
      merchant: transaction.merchant.trim().toLowerCase(),
      amountCents: transaction.amountCents,
    },
    update: { amountCents: transaction.amountCents },
  });

  revalidatePath("/transactions");
  revalidatePath("/bills");
  if (bill.bucketId) revalidatePath(`/buckets/${bill.bucketId}`);
  return {};
}

// Manual "this transaction IS an existing bill's payment" — the counterpart
// to attachExtraBillCharge above for a real payment matchBillPayments' own
// automatic matcher missed (see attachTransactionAsBillPayment's doc
// comment, recurring-bills.ts, for why: a bank-garbled merchant descriptor
// can score too low against bill.merchant for nameSimilarity to ever accept
// it, even though it's genuinely that cycle's charge). Rolls the bill's own
// lastPaidDate/nextDueDate/amountCents forward, unlike the extra-charge
// path — this is the cycle's real payment being reconciled, not an
// ancillary fee.
export async function linkTransactionToExistingBill(
  transactionId: string,
  billId: string,
): Promise<{ error?: string }> {
  const session = await requireFullAccess();

  const [transaction, bill] = await Promise.all([
    db.transaction.findUnique({ where: { id: transactionId } }),
    db.recurringBill.findUnique({ where: { id: billId } }),
  ]);
  if (!belongsToHousehold(transaction, session.user.householdId)) return { error: "Charge not found." };
  if (!belongsToHousehold(bill, session.user.householdId)) return { error: "Bill not found." };
  if (transaction.billId) return { error: "That charge is already linked to a bill." };
  if (transaction.amountCents <= 0) return { error: "Only a debit can be linked to a bill." };

  await attachTransactionAsBillPayment(transactionId, bill, transaction);

  revalidatePath("/");
  revalidatePath("/buckets");
  revalidatePath("/transactions");
  revalidatePath("/bills");
  if (bill.bucketId) revalidatePath(`/buckets/${bill.bucketId}`);
  return {};
}

// Household says yes, the bill's amount really changed — see
// BillAmountReview's schema comment. Writes the new amount and clears the
// question either way.
export async function confirmBillAmountChanged(reviewId: string): Promise<void> {
  const session = await requireFullAccess();

  const review = await db.billAmountReview.findUnique({ where: { id: reviewId } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  await db.recurringBill.update({ where: { id: review.billId }, data: { amountCents: review.observedAmountCents } });
  await db.billAmountReview.delete({ where: { id: reviewId } });

  revalidatePath("/bills");
  revalidatePath("/");
}

// Household says no — the email was a wrong match, a one-off adjustment, or
// otherwise not a real change to the tracked amount. Just clears the
// question; RecurringBill.amountCents is never touched.
export async function declineBillAmountChanged(reviewId: string): Promise<void> {
  const session = await requireFullAccess();

  const review = await db.billAmountReview.findUnique({ where: { id: reviewId } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  await db.billAmountReview.delete({ where: { id: reviewId } });

  revalidatePath("/bills");
  revalidatePath("/");
}
