"use server";

import { CLEARED_CLASSIFICATION } from "@/lib/classification-reset";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { belongsToHousehold, requireFullAccess } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { addPaycheckCadence, semiMonthlyDaysOrDefault } from "@/lib/income-calc";
import { dismissUnlabeledP2P } from "@/lib/p2p-transfers";
import { todayAsUTCDate } from "@/lib/date";

const createIncomeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.string(),
  cadence: z.enum(["BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"]),
  nextPayDate: z.string().optional(),
});

export type IncomeFormState = { error?: string };

// The SEMI_MONTHLY pay-day pair from the form's two day pickers (empty for
// other cadences). A picker left blank falls back to a pair guessed from
// the pay date (see semiMonthlyDaysOrDefault) so every semi-monthly row
// stores one.
function semiMonthlyDaysFromForm(
  formData: FormData,
  cadence: string,
  reference: Date,
): { days: number[] } | { error: string } {
  if (cadence !== "SEMI_MONTHLY") return { days: [] };
  const picked = [formData.get("semiMonthlyDay1"), formData.get("semiMonthlyDay2")]
    .filter((v) => typeof v === "string" && v !== "")
    .map(Number);
  if (picked.length === 2 && picked[0] === picked[1]) return { error: "Pick two different pay days." };
  return { days: semiMonthlyDaysOrDefault(picked.length === 2 ? picked : null, reference) };
}

// The income counterpart to createBillFromTransaction (src/app/bills/actions.ts)
// and createDebtPaymentFromTransaction (src/app/debts/actions.ts) — turns
// any transaction into a tracked recurring Income, for a paycheck/credit
// detectRecurringIncome never caught (too few occurrences so far, an
// irregular amount). Used by TrackAsBillForm's "Recurring income" option.
// Resets the same mutually-exclusive classification fields
// reassignTransaction's income branch does (src/app/buckets/actions.ts) —
// works on a transaction that already had a bucket/debt/transfer, not just
// a never-classified one.
export async function createIncomeFromTransaction(
  transactionId: string,
  _prev: IncomeFormState,
  formData: FormData,
): Promise<IncomeFormState> {
  const session = await requireFullAccess();

  const transaction = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!belongsToHousehold(transaction, session.user.householdId)) return { error: "Not found." };
  if (transaction.incomeId) return { error: "Already tracked." };

  const parsed = createIncomeSchema.safeParse({
    name: formData.get("name"),
    amount: formData.get("amount"),
    cadence: formData.get("cadence"),
    nextPayDate: formData.get("nextPayDate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) return { error: "Enter a valid paycheck amount." };

  let nextPayDate: Date | undefined;
  if (parsed.data.nextPayDate) {
    const d = new Date(parsed.data.nextPayDate);
    if (Number.isNaN(d.getTime())) return { error: "Enter a valid date." };
    nextPayDate = d;
  }

  const semiMonthly = semiMonthlyDaysFromForm(formData, parsed.data.cadence, nextPayDate ?? transaction.occurredOn);
  if ("error" in semiMonthly) return { error: semiMonthly.error };

  const income = await db.income.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      // The transaction's own merchant text, not the (possibly friendlier,
      // user-typed) display name above — matchIncomePayments needs the raw
      // synced text to recognize future deposits regardless of what this
      // income gets renamed to later.
      merchant: transaction.merchant,
      amountCents,
      cadence: parsed.data.cadence,
      semiMonthlyDays: semiMonthly.days,
      nextPayDate,
      lastReceivedDate: transaction.occurredOn,
      // Always SIMPLEFIN — this Income is being created from a synced
      // transaction, and every transaction is synced (manual entry was
      // removed 2026-08-15).
      source: "SIMPLEFIN",
      accountId: transaction.accountId,
    },
  });

  await db.transaction.update({
    where: { id: transactionId },
    data: {
      ...CLEARED_CLASSIFICATION,
      incomeId: income.id,
      isIncome: true,
      // Now tracked as recurring income, so no longer a one-time credit.
      oneOff: false,
    },
  });

  revalidatePath("/income");
  revalidatePath("/buckets");
  revalidatePath("/transactions");
  revalidatePath("/debts");
  return {};
}

const updateIncomeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.string(),
  cadence: z.enum(["BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"]),
  nextPayDate: z.string().optional(),
});

export async function updateIncome(
  incomeId: string,
  _prev: IncomeFormState,
  formData: FormData,
): Promise<IncomeFormState> {
  const session = await requireFullAccess();

  const income = await db.income.findUnique({ where: { id: incomeId } });
  if (!belongsToHousehold(income, session.user.householdId)) return { error: "Not found." };

  const parsed = updateIncomeSchema.safeParse({
    name: formData.get("name"),
    amount: formData.get("amount"),
    cadence: formData.get("cadence"),
    nextPayDate: formData.get("nextPayDate") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const amountCents = parseDollarsToCents(parsed.data.amount);
  if (amountCents === null || amountCents === 0) {
    return { error: "Enter a valid paycheck amount." };
  }

  let nextPayDate: Date | undefined;
  if (parsed.data.nextPayDate) {
    const d = new Date(parsed.data.nextPayDate);
    if (Number.isNaN(d.getTime())) return { error: "Enter a valid date." };
    nextPayDate = d;
  }

  const semiMonthly = semiMonthlyDaysFromForm(
    formData,
    parsed.data.cadence,
    nextPayDate ?? income.nextPayDate ?? todayAsUTCDate(),
  );
  if ("error" in semiMonthly) return { error: semiMonthly.error };

  await db.income.update({
    where: { id: incomeId },
    data: {
      name: parsed.data.name,
      amountCents,
      cadence: parsed.data.cadence,
      semiMonthlyDays: semiMonthly.days,
      nextPayDate,
    },
  });

  revalidatePath("/income");
  revalidatePath("/debts");
  revalidatePath("/transactions");
  return {};
}

// Manual "this paycheck came in" for an income with no accountId match (a
// cash side gig, or a synced one matchIncomePayments hasn't caught yet) —
// advances the schedule exactly the same way an auto-match does, just
// without a transaction to link. Mirrors markBillPaid.
export async function markIncomeReceived(incomeId: string) {
  const session = await requireFullAccess();

  const income = await db.income.findUnique({ where: { id: incomeId } });
  if (!belongsToHousehold(income, session.user.householdId)) return;

  await db.income.update({
    where: { id: incomeId },
    data: {
      lastReceivedDate: todayAsUTCDate(), // @db.Date — local calendar day, not a raw UTC instant
      nextPayDate: income.nextPayDate
        ? addPaycheckCadence(income.nextPayDate, income.cadence, income.semiMonthlyDays)
        : null,
    },
  });
  revalidatePath("/income");
  revalidatePath("/debts");
}

export async function deleteIncome(incomeId: string) {
  const session = await requireFullAccess();

  const income = await db.income.findUnique({ where: { id: incomeId } });
  if (!belongsToHousehold(income, session.user.householdId)) return;

  await db.income.delete({ where: { id: incomeId } });
  revalidatePath("/income");
  revalidatePath("/debts");
}

export async function acceptIncomeSuggestion(
  key: string,
  name: string,
  amountCents: number,
  cadence: "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY",
  semiMonthlyDays: number[],
  nextPayDate: string,
  accountId: string,
  transactionIds: string[],
) {
  const session = await requireFullAccess();

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!belongsToHousehold(account, session.user.householdId)) return;

  const history = await db.transaction.findMany({
    where: { id: { in: transactionIds }, householdId: session.user.householdId },
    select: { id: true, occurredOn: true, merchant: true },
    orderBy: { occurredOn: "desc" },
  });

  const income = await db.income.create({
    data: {
      // The suggestion's own synced merchant text — matchIncomePayments
      // needs this regardless of `name` below (currently the same value,
      // but kept independent so `name` stays free to rename later).
      merchant: history[0]?.merchant ?? name,
      householdId: session.user.householdId,
      name,
      amountCents,
      cadence,
      semiMonthlyDays: cadence === "SEMI_MONTHLY" ? semiMonthlyDaysOrDefault(semiMonthlyDays, new Date(nextPayDate)) : [],
      nextPayDate: new Date(nextPayDate),
      lastReceivedDate: history[0]?.occurredOn,
      source: "SIMPLEFIN",
      accountId,
    },
  });
  // Adopt the history that led to this suggestion, same as acceptBillSuggestion.
  await db.transaction.updateMany({
    where: { id: { in: history.map((h) => h.id) } },
    data: { incomeId: income.id },
  });
  // Don't keep suggesting once it's tracked.
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "INCOME", key } },
    create: { householdId: session.user.householdId, kind: "INCOME", key },
    update: {},
  });

  revalidatePath("/income");
  revalidatePath("/debts");
}

export async function dismissIncomeSuggestion(key: string) {
  const session = await requireFullAccess();

  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "INCOME", key } },
    create: { householdId: session.user.householdId, kind: "INCOME", key },
    update: {},
  });
  revalidatePath("/income");
}

// "Yes, that money really did come in — but don't treat it as a repeating
// paycheck." Marks every transaction the suggestion grouped together as a
// reviewed one-time credit (so month-of-record totals still count them) and
// stops the pattern from being suggested again, without creating a
// recurring Income source for it.
export async function markIncomeSuggestionOneOff(key: string, transactionIds: string[]) {
  const session = await requireFullAccess();

  await db.transaction.updateMany({
    where: { id: { in: transactionIds }, householdId: session.user.householdId },
    data: { oneOff: true },
  });
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId: session.user.householdId, kind: "INCOME", key } },
    create: { householdId: session.user.householdId, kind: "INCOME", key },
    update: {},
  });
  revalidatePath("/income");
  revalidatePath("/");
}

export async function dismissUnlabeledP2PCredits() {
  const session = await requireFullAccess();
  await dismissUnlabeledP2P(session.user.householdId, "CREDIT");
  revalidatePath("/income");
  revalidatePath("/");
}
