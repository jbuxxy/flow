"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { belongsToHousehold, requireFullAccess } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { reassignTransactionsForPattern } from "@/lib/pattern-reassign";
import { patternMatchData } from "@/lib/pattern-match";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { matchPatternPayments } from "@/lib/pattern-payments";
import { nextBillDueDate, amountToleranceCents } from "@/lib/recurring-bills";
import { reconcileAdHocTopUps } from "@/lib/bucket-ad-hoc-topup";
import { matchReimbursements, offsetSumByCreditId, type ReimbursementCandidate } from "@/lib/reimbursements";
import { linkReceipt, linkReceiptToPlan, linkReceiptToTransactionLegs } from "@/lib/receipt-sync";
import { plausibleReceiptCharge, aliasKey, receiptSignMatches } from "@/lib/receipt-match";
import { resolveCategoryId } from "@/lib/bill-category-resolve";
import { revalidateHousehold } from "@/lib/revalidate";

export type { ReimbursementCandidate };

// The manual half of returns/reimbursements (the automatic half is
// matchReimbursements, src/lib/reimbursements.ts, scoped to a
// RecurringPattern explicitly pinned to a bill) — a household picking a
// specific credit and pointing it at the specific purchase/bill payment it
// pays back. Both directions checked server-side, not just trusted from
// whichever button the UI happened to show.
export async function linkReimbursement(creditTransactionId: string, debitTransactionId: string) {
  const session = await requireFullAccess();

  const [credit, debit] = await Promise.all([
    db.transaction.findUnique({ where: { id: creditTransactionId } }),
    db.transaction.findUnique({ where: { id: debitTransactionId } }),
  ]);
  if (!belongsToHousehold(credit, session.user.householdId)) return;
  if (!belongsToHousehold(debit, session.user.householdId)) return;
  if (credit.amountCents >= 0 || debit.amountCents <= 0) return;

  await db.transaction.update({
    where: { id: creditTransactionId },
    data: {
      reimbursesTransactionId: debitTransactionId,
      reimbursesMerchant: null,
      // A P2P credit defaults to isIncome:true at sync time (see
      // simplefin-sync.ts) before the household says which of the three
      // things it actually is — confirming it as a reimbursement here
      // means it's specifically NOT income, so that default must be
      // cleared, not just left to sit alongside reimbursesTransactionId.
      isIncome: false,
      // oneOff:true is what actually drops it out of getUnlabeledP2PTransfers
      // (src/lib/p2p-transfers.ts) — without it, a linked-but-otherwise-
      // undisposed credit (no bucket/debt/income, no pattern) would still
      // match that query's OR clause and keep showing up in the "unlabeled"
      // queue as if nothing had been decided about it.
      oneOff: true,
      // A previously-dismissed credit being linked after all — clear it so
      // it can't get stuck "dismissed" forever if it's later unlinked again.
      refundReviewDismissed: false,
      // Nets the refund against the same bucket the original purchase
      // counted against — getBucketsWithProgress (src/lib/buckets.ts) sums
      // every bucketId-matching transaction regardless of sign, so this
      // alone reduces that bucket's spent total by the refunded amount.
      // Left untouched when the debit itself has no bucket (e.g. a
      // non-budget-tracked account).
      ...(debit.bucketId ? { bucketId: debit.bucketId } : {}),
    },
  });
  // No longer ad hoc income — revoke any bucket top-ups it funded.
  await reconcileAdHocTopUps(session.user.householdId);
  revalidateHousehold();
}

// The fallback for when a household knows a credit is a refund but can't
// pin down which specific past debit it pays back (e.g. one of 15 Walmart
// trips) — see ReimbursementLinker's "Can't find it?" flow. There's no
// debit to inherit a bucket from here, so bucketId is optional and picked
// directly by the household if they want the refund to net against one.
export async function linkReimbursementToMerchant(creditTransactionId: string, merchant: string, bucketId?: string) {
  const session = await requireFullAccess();

  const trimmed = merchant.trim();
  if (!trimmed) return;

  const credit = await db.transaction.findUnique({ where: { id: creditTransactionId } });
  if (!belongsToHousehold(credit, session.user.householdId)) return;
  if (credit.amountCents >= 0) return;

  let bucket = null;
  if (bucketId) {
    bucket = await db.bucket.findUnique({ where: { id: bucketId } });
    if (!belongsToHousehold(bucket, session.user.householdId)) return;
  }

  await db.transaction.update({
    where: { id: creditTransactionId },
    data: {
      reimbursesMerchant: trimmed,
      reimbursesTransactionId: null,
      // See linkReimbursement's comment on the same field.
      isIncome: false,
      oneOff: true,
      // A previously-dismissed credit being linked after all — clear it so
      // it can't get stuck "dismissed" forever if it's later unlinked again.
      refundReviewDismissed: false,
      ...(bucket ? { bucketId: bucket.id } : {}),
    },
  });
  await reconcileAdHocTopUps(session.user.householdId);
  revalidateHousehold();
}

export async function unlinkReimbursement(creditTransactionId: string) {
  const session = await requireFullAccess();

  const credit = await db.transaction.findUnique({ where: { id: creditTransactionId } });
  if (!belongsToHousehold(credit, session.user.householdId)) return;

  await db.transaction.update({
    where: { id: creditTransactionId },
    // bucketId here was only ever set by linkReimbursement/
    // linkReimbursementToMerchant above — a credit is never manually
    // reassignable to a bucket in the UI — so unlinking always owns
    // reverting it too, same as the reimburses fields themselves.
    //
    // linkReimbursement flipped isIncome:false + oneOff:true when it linked;
    // undoing the link must undo those too, or the credit lands in limbo
    // (not income, not a reimbursement, invisible to every review queue AND
    // — because isConfirmedPlainIncome hides the linker for isIncome+oneOff —
    // impossible to re-link). Money-in defaults to income at sync, and the
    // unlink confirm copy already says it goes back to "needing a call on
    // income vs. reimbursement," so restore exactly that reviewable state.
    data: {
      reimbursesTransactionId: null,
      reimbursesMerchant: null,
      bucketId: null,
      isIncome: true,
      oneOff: false,
    },
  });
  revalidateHousehold();
}

// The explicit "none of these" exit from the refund-matching flow — a
// credit that isn't actually a refund, or whose original purchase isn't
// worth tracking down. Distinct from unlinkReimbursement (which reverts an
// already-decided link back to needing review) and from the household-wide
// weekly dismissRefundMatchReview (src/lib/refund-match.ts, which only
// snoozes the dashboard card) — this settles one specific transaction so it
// stops showing up in getUnmatchedRefunds. Toggleable: linking or
// re-dismissing later just flips this back.
export async function dismissRefundReview(creditTransactionId: string, dismissed: boolean) {
  const session = await requireFullAccess();

  const credit = await db.transaction.findUnique({ where: { id: creditTransactionId } });
  if (!belongsToHousehold(credit, session.user.householdId)) return;

  await db.transaction.update({
    where: { id: creditTransactionId },
    data: { refundReviewDismissed: dismissed },
  });
  revalidateHousehold();
}

// The split counterpart of linkReimbursement — carve `amountCents` of a
// credit off against one specific debit (a loan payoff, a bill payment),
// leaving the rest to still count as income. Repeatable: call once per
// target. Mutually exclusive with the whole-amount reimburses* fields.
export async function addTransactionOffset(
  creditTransactionId: string,
  debitTransactionId: string,
  amountCents: number,
) {
  const session = await requireFullAccess();
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { error: "Enter an amount." };

  const [credit, debit] = await Promise.all([
    db.transaction.findUnique({ where: { id: creditTransactionId } }),
    db.transaction.findUnique({ where: { id: debitTransactionId } }),
  ]);
  if (!belongsToHousehold(credit, session.user.householdId)) return { error: "Not found." };
  if (!belongsToHousehold(debit, session.user.householdId)) return { error: "Not found." };
  if (credit.amountCents >= 0) return { error: "Only a credit (money in) can be split." };
  if (credit.reimbursesTransactionId || credit.reimbursesMerchant)
    return { error: "This credit is already linked as a whole reimbursement — unlink that first." };
  // A valid target is real money out (amountCents > 0) or a tracked debt
  // payment — the latter may post as a balance-reducing credit on the loan's
  // own feed (amountCents < 0) with no checking-side leg at all.
  const debitOutflowCents = Math.abs(debit.amountCents);
  if (debit.amountCents <= 0 && !debit.debtId)
    return { error: "Pick a payment or debt payoff to offset." };
  if (amountCents > debitOutflowCents)
    return { error: `That payment was only ${(debitOutflowCents / 100).toFixed(2)}.` };

  const already = (await offsetSumByCreditId([creditTransactionId])).get(creditTransactionId) ?? 0;
  const existing = await db.transactionOffset.findUnique({
    where: { creditTransactionId_debitTransactionId: { creditTransactionId, debitTransactionId } },
    select: { amountCents: true },
  });
  const remaining = Math.abs(credit.amountCents) - (already - (existing?.amountCents ?? 0));
  if (amountCents > remaining)
    return { error: `Only ${(remaining / 100).toFixed(2)} of this deposit is left to allocate.` };

  await db.transactionOffset.upsert({
    where: { creditTransactionId_debitTransactionId: { creditTransactionId, debitTransactionId } },
    create: { householdId: session.user.householdId, creditTransactionId, debitTransactionId, amountCents },
    update: { amountCents },
  });
  // A decided credit — drops out of the unlabeled-P2P queue (oneOff:false is
  // that queue's "still undecided" marker) — but it stays isIncome:true: the
  // unallocated remainder is real income.
  await db.transaction.update({
    where: { id: creditTransactionId },
    data: { isIncome: true, oneOff: true },
  });
  // The carved-off slice no longer counts as income — trim any bucket
  // top-ups this credit funded down to what it still counts for.
  await reconcileAdHocTopUps(session.user.householdId);
  revalidateHousehold();
  return { ok: true };
}

export async function removeTransactionOffset(offsetId: string) {
  const session = await requireFullAccess();

  const offset = await db.transactionOffset.findUnique({
    where: { id: offsetId },
    include: { debit: { select: { bucketId: true } } },
  });
  if (!belongsToHousehold(offset, session.user.householdId)) return;

  await db.transactionOffset.delete({ where: { id: offsetId } });
  revalidateHousehold();
}

// Fallback search behind the amount-match suggestions in ReimbursementLinker
// — for a P2P reimbursement, the credit's own merchant text is generic
// ("Venmo") and carries no relation to what it's paying back, so the
// suggestion list is often empty and a household needs to find the target
// by its own merchant/bill name instead (e.g. "verizon"). Takes the credit
// itself (not just its amount/date) so the same two invariants
// getReimbursementSuggestions already enforces hold here too — a household
// report, 2026-09-05, showed this fallback search offering purchases smaller
// than the refund itself and ones dated *after* it, neither of which can
// ever be what a credit pays back: what you're paying back happened at or
// before the payback, and cost at least as much.
export async function searchLinkableDebits(creditTransactionId: string, query: string): Promise<ReimbursementCandidate[]> {
  const session = await requireFullAccess();

  const trimmed = query.trim();
  if (!trimmed) return [];

  const credit = await db.transaction.findUnique({
    where: { id: creditTransactionId },
    select: { householdId: true, amountCents: true, occurredOn: true, merchant: true, accountId: true },
  });
  if (!belongsToHousehold(credit, session.user.householdId)) return [];

  // This search box opens pre-filled with the credit's own merchant text and
  // auto-searches on open (see ReimbursementLinker), so most of the time
  // this *is* the same-merchant case — a refund can only land back on
  // whatever account the original purchase was actually made on, same
  // reasoning as getReimbursementSuggestions' own same-account rule (real
  // household report, 2026-09-06: a card's own refund was suggesting
  // purchases made on plain checking instead). Only when the household
  // actually types something else — a different merchant/bill name, the
  // whole reason this fallback exists for a generic P2P credit — does
  // cross-account stay fair game: a friend reimbursing you isn't tied to
  // any one of your cards.
  const isSameMerchantSearch = trimmed.toLowerCase() === credit.merchant.trim().toLowerCase();

  const debits = await db.transaction.findMany({
    where: {
      householdId: session.user.householdId,
      amountCents: { gte: Math.abs(credit.amountCents) },
      occurredOn: { lte: credit.occurredOn },
      merchant: { contains: trimmed, mode: "insensitive" },
      ...(isSameMerchantSearch ? { accountId: credit.accountId } : {}),
      // A purchase already claimed by a different refund isn't offered
      // again — same rule findRefundPurchaseCandidates (src/lib/refund-match.ts)
      // uses for its own candidate pool.
      reimbursedBy: { none: {} },
    },
    orderBy: { occurredOn: "desc" },
    take: 20,
    select: { id: true, merchant: true, amountCents: true, occurredOn: true, billId: true, bill: { select: { name: true } } },
  });

  return debits.map((d) => ({
    id: d.id,
    merchant: d.merchant,
    amountCents: d.amountCents,
    occurredOn: d.occurredOn.toISOString().slice(0, 10),
    billId: d.billId,
    billName: d.bill?.name ?? null,
  }));
}

// The split-offset flow's target search (see addTransactionOffset). Unlike
// searchLinkableDebits, matches on the linked debt's name too and returns
// tracked debt payments regardless of sign — a loan payoff is the usual
// target and often only exists as a negative "Payment" on the loan's own
// feed. Amounts come back positive (absolute); a debt payment shows its
// debt name.
export async function searchOffsetTargets(query: string): Promise<ReimbursementCandidate[]> {
  const session = await requireFullAccess();

  const trimmed = query.trim();
  if (!trimmed) return [];

  const rows = await db.transaction.findMany({
    where: {
      householdId: session.user.householdId,
      OR: [
        { amountCents: { gt: 0 }, merchant: { contains: trimmed, mode: "insensitive" } },
        { debtId: { not: null }, merchant: { contains: trimmed, mode: "insensitive" } },
        { debt: { name: { contains: trimmed, mode: "insensitive" } } },
      ],
    },
    orderBy: { occurredOn: "desc" },
    // Over-fetch a little: the twin-leg de-dup below can drop rows, and 20 is
    // what the caller wants to end up showing.
    take: 30,
    select: {
      id: true,
      merchant: true,
      amountCents: true,
      occurredOn: true,
      accountId: true,
      billId: true,
      bill: { select: { name: true } },
      debt: { select: { name: true, accountId: true } },
    },
  });

  // A single debt payment often posts as two transactions — the checking-side
  // debit ("Transfer to Loan", amountCents > 0) and the balance-reducing
  // credit on the debt's own account ("Payment from Checking", amountCents < 0)
  // — both carrying the same debtId (the depository leg via
  // matchDepositoryDebtPaymentLegs). searchOffsetTargets renders both with the
  // debt's name and the absolute amount, so they show as an identical
  // duplicate row. Collapse each such pair to the leg on the debt's own
  // account — the canonical one filterDebtPaymentTwins keeps linked to the
  // DebtPayment (see WORKING_ON.md). Only ever drops a *checking-side* leg
  // that has a same-debt, same-|amount|, within-3-days loan-side counterpart;
  // a lone leg of either kind is left as-is.
  const TWIN_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
  const loanSide = rows.filter((r) => r.debt?.accountId && r.accountId === r.debt.accountId);
  const deduped = rows.filter((r) => {
    if (!r.debt?.accountId || r.accountId === r.debt.accountId) return true;
    const hasLoanTwin = loanSide.some(
      (l) =>
        l.debt?.accountId === r.debt?.accountId &&
        Math.abs(l.amountCents) === Math.abs(r.amountCents) &&
        Math.abs(l.occurredOn.getTime() - r.occurredOn.getTime()) <= TWIN_WINDOW_MS,
    );
    return !hasLoanTwin;
  });

  return deduped.slice(0, 20).map((d) => ({
    id: d.id,
    merchant: d.merchant,
    amountCents: Math.abs(d.amountCents),
    occurredOn: d.occurredOn.toISOString().slice(0, 10),
    billId: d.billId,
    billName: d.bill?.name ?? null,
    debtName: d.debt?.name ?? null,
  }));
}

// --- RecurringPattern management (formerly src/app/transfers/actions.ts) ---
// Patterns are now created from an actual unlabeled P2P transaction (via
// PatternPanel, src/components/pattern-panel.tsx, from this page's own
// "Unlabeled P2P" filter) and edited/deleted from wherever they surface —
// their own bucket's page, the Income page, a bill's row, or DebtRow's
// compact link back into this page's `?status=debt&debtId=` filter — all
// via the shared PatternRow (src/components/pattern-row.tsx).

const patternSchema = z.object({
  label: z.string().trim().min(1).max(60),
  direction: z.enum(["CREDIT", "DEBIT"]),
  channelKeyword: z.string().trim().min(1).max(40),
  // Mutually exclusive with `amount` below, not both required — PatternFields
  // only ever renders one or the other depending on whether a real cadence
  // is set (see its own comment), so whichever the household didn't fill in
  // simply never arrives in the FormData at all.
  amountMin: z.string().optional(),
  amountMax: z.string().optional(),
  // A scheduled pattern (cadence set) asks for one real amount + an optional
  // tolerance instead of a min/max range — the range was pure redundancy
  // once a tolerance exists (household feedback, 2026-09-11): amountMinCents/
  // amountMaxCents are still derived and stored the same way underneath
  // (every other read site — matchPatternPayments, PatternRow's expectedCents
  // — already keys off that pair), just computed from amount±tolerance here
  // instead of typed directly.
  amount: z.string().optional(),
  dayOfMonthStart: z.string().optional(),
  dayOfMonthEnd: z.string().optional(),
  weekdays: z.array(z.string()).optional(),
  target: z.string().optional(),
  countsAsIncome: z.string().optional(),
  billId: z.string().optional(),
  categoryId: z.string().optional(),
  // The real P2P person this pattern is scoped to (see the schema comment
  // on RecurringPattern.counterpartyName) — blank when there's nothing to
  // resolve it from (no email connected, or the transaction has no receipt
  // yet), in which case this pattern keeps matching on channelKeyword +
  // amount alone, exactly as before this field existed.
  counterpartyName: z.string().trim().max(120).optional(),
  noteKeywords: z.array(z.string()).optional(),
  // Blank cadence = this pattern stays unscheduled (today's behavior) —
  // matched by the generic per-sync categorizer instead of the cycle-aware
  // matchPatternPayments.
  cadence: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY", "ANNUAL"]).optional(),
  nextDueDate: z.string().optional(),
  tolerance: z.string().optional(),
});

export type PatternFormState = { error?: string };

// The DEBIT target select posts a single "bucket:<id>" / "debt:<id>" value
// rather than two separate fields, so the two are structurally impossible
// to both end up set. Ownership of whichever id comes back is checked
// here, not just trusted from the form.
async function resolveTarget(
  householdId: string,
  direction: "CREDIT" | "DEBIT",
  target: string | undefined,
): Promise<{ bucketId: string | null; debtId: string | null } | { error: string }> {
  if (direction !== "DEBIT" || !target) return { bucketId: null, debtId: null };

  const [kind, id] = target.split(":");
  if (kind === "bucket" && id) {
    const bucket = await db.bucket.findUnique({ where: { id } });
    if (!belongsToHousehold(bucket, householdId)) return { error: "Bucket not found." };
    return { bucketId: bucket.id, debtId: null };
  }
  if (kind === "debt" && id) {
    const debt = await db.debt.findUnique({ where: { id } });
    if (!belongsToHousehold(debt, householdId)) return { error: "Debt not found." };
    return { bucketId: null, debtId: debt.id };
  }
  return { bucketId: null, debtId: null };
}

async function parseCommon(householdId: string, formData: FormData) {
  const parsed = patternSchema.safeParse({
    label: formData.get("label"),
    direction: formData.get("direction"),
    channelKeyword: formData.get("channelKeyword"),
    amountMin: formData.get("amountMin") || undefined,
    amountMax: formData.get("amountMax") || undefined,
    amount: formData.get("amount") || undefined,
    dayOfMonthStart: formData.get("dayOfMonthStart") || undefined,
    dayOfMonthEnd: formData.get("dayOfMonthEnd") || undefined,
    weekdays: formData.getAll("weekdays") as string[],
    target: formData.get("target") || undefined,
    countsAsIncome: formData.get("countsAsIncome") || undefined,
    billId: formData.get("billId") || undefined,
    // Real bug, 2026-09-11: declared in the schema below but never actually
    // read off the submitted form here — resolveCategoryId always got
    // `undefined` regardless of what the household picked in CategoryPicker,
    // so it always short-circuited to null (its own `if (!categoryId) return
    // null` guard) and every pattern save silently wiped categoryId back to
    // "Uncategorized," bucket-targeted and reimbursement patterns alike.
    categoryId: formData.get("categoryId") || undefined,
    counterpartyName: formData.get("counterpartyName") || undefined,
    // One comma-separated field, not repeated same-named inputs — simpler
    // form UI (a household types "Sammy, Sam" in one box) for what's
    // really just a short, rarely-edited list.
    noteKeywords: String(formData.get("noteKeywords") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    cadence: formData.get("cadence") || undefined,
    nextDueDate: formData.get("nextDueDate") || undefined,
    tolerance: formData.get("tolerance") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" } as const;

  const dayOfMonthStart = parsed.data.dayOfMonthStart ? Number(parsed.data.dayOfMonthStart) : null;
  const dayOfMonthEnd = parsed.data.dayOfMonthEnd ? Number(parsed.data.dayOfMonthEnd) : null;
  if (
    (dayOfMonthStart !== null && (dayOfMonthStart < 1 || dayOfMonthStart > 31)) ||
    (dayOfMonthEnd !== null && (dayOfMonthEnd < 1 || dayOfMonthEnd > 31))
  ) {
    return { error: "Day of month must be between 1 and 31." } as const;
  }

  // Blank = stays unscheduled (today's behavior, matched by the generic
  // categorizer) — a household with no email connected, or one that just
  // doesn't want a real due date tracked, never has to set these.
  let cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL" | null = null;
  let nextDueDate: Date | null = null;
  let toleranceCents: number | null = null;
  let amountMinCents: number;
  let amountMaxCents: number;
  if (parsed.data.cadence) {
    if (!parsed.data.nextDueDate) return { error: "Enter a due date." } as const;
    const d = new Date(parsed.data.nextDueDate);
    if (Number.isNaN(d.getTime())) return { error: "Enter a valid due date." } as const;
    cadence = parsed.data.cadence;
    nextDueDate = d;
    if (parsed.data.tolerance) {
      toleranceCents = parseDollarsToCents(parsed.data.tolerance);
      if (toleranceCents === null) return { error: "Enter a valid tolerance." } as const;
    }
    // A scheduled pattern types one real amount, not a range — the range
    // was pure redundancy once a tolerance exists (household feedback,
    // 2026-09-11). amountMinCents/amountMaxCents are still what every read
    // site (matchPatternPayments, PatternRow's expectedCents) keys off, so
    // derive that same pair from amount ± (explicit tolerance, or the same
    // 30%-of-amount/$5-floor auto-tolerance a bill falls back to when it
    // hasn't got one either).
    if (!parsed.data.amount) return { error: "Enter an amount." } as const;
    const amountCents = parseDollarsToCents(parsed.data.amount);
    if (amountCents === null) return { error: "Enter a valid amount." } as const;
    const effectiveTolerance = toleranceCents ?? amountToleranceCents(amountCents);
    amountMinCents = amountCents - effectiveTolerance;
    amountMaxCents = amountCents + effectiveTolerance;
  } else {
    const parsedMin = parsed.data.amountMin ? parseDollarsToCents(parsed.data.amountMin) : null;
    const parsedMax = parsed.data.amountMax ? parseDollarsToCents(parsed.data.amountMax) : null;
    if (parsedMin === null || parsedMax === null || parsedMin > parsedMax) {
      return { error: "Enter a valid amount range (min ≤ max)." } as const;
    }
    amountMinCents = parsedMin;
    amountMaxCents = parsedMax;
  }
  const counterpartyName = parsed.data.counterpartyName?.trim() || null;
  const noteKeywords = parsed.data.noteKeywords ?? [];

  const target = await resolveTarget(householdId, parsed.data.direction, parsed.data.target);
  if ("error" in target) return target;

  const countsAsIncome = parsed.data.direction === "CREDIT" && parsed.data.countsAsIncome === "on";
  // Only ever meaningful for a CREDIT pattern that's a reimbursement (not
  // income) — a household could submit a stale billId left over from
  // toggling countsAsIncome client-side, so re-derive from the same
  // direction/countsAsIncome check rather than trusting the field's mere
  // presence. Ownership checked, not just trusted from the form.
  let billId: string | null = null;
  if (parsed.data.direction === "CREDIT" && !countsAsIncome && parsed.data.billId) {
    const bill = await db.recurringBill.findUnique({ where: { id: parsed.data.billId } });
    if (!belongsToHousehold(bill, householdId)) return { error: "Bill not found." } as const;
    billId = bill.id;
  }

  // A debt-targeted or CREDIT (income/reimbursement) pattern has no bucket
  // to scope a category by at all — resolveCategoryId's bucketId check is
  // skipped (undefined, not null) only for that reason, matching the
  // accepted exception on RecurringPattern.categoryId's own comment.
  // A bill-pinned reimbursement is the one further exception: it never
  // carries its own category at all, full stop — it's the bill's own
  // category that applies wherever one's shown (see the construction sites
  // that build categoryName for one of these). Enforced here, not just by
  // PatternFields omitting the field, since the form is what a household
  // sees, not what a household is limited to sending.
  const categoryId = billId
    ? null
    : await resolveCategoryId(householdId, parsed.data.categoryId, target.bucketId ?? undefined);

  return {
    data: {
      label: parsed.data.label,
      direction: parsed.data.direction,
      channelKeyword: parsed.data.channelKeyword.toLowerCase(),
      amountMinCents,
      amountMaxCents,
      dayOfMonthStart,
      dayOfMonthEnd,
      weekdays: (parsed.data.weekdays ?? []).map(Number),
      bucketId: target.bucketId,
      debtId: target.debtId,
      countsAsIncome,
      billId,
      categoryId,
      counterpartyName,
      noteKeywords,
      cadence,
      nextDueDate,
      toleranceCents,
    },
  } as const;
}

// sourceTransactionId: the transaction PatternPanel was opened from, when
// any (the "Needs a bucket"/generic pattern-composer flows have none).
// Without some guarantee here, the very transaction a household built the
// pattern from — the one guaranteed to match — could end up neither linked
// (`patternId`) nor recategorized (`categoryId`), silently (real report,
// 2026-09-11).
export async function createPattern(
  sourceTransactionId: string | null,
  _prev: PatternFormState,
  formData: FormData,
): Promise<PatternFormState> {
  const session = await requireFullAccess();

  const result = await parseCommon(session.user.householdId, formData);
  if ("error" in result) return { error: result.error };

  const pattern = await db.recurringPattern.create({
    data: { householdId: session.user.householdId, ...result.data },
  });

  // Run the real matchers FIRST, while the source transaction is still
  // patternId: null — matchPatternPayments' own candidate query for a
  // scheduled pattern requires patternId: null, so force-linking the source
  // transaction before this ran made it invisible to its own pattern's
  // cycle-matcher: the pattern's first cycle stayed "still due" forever even
  // though the transaction it was built from was the real payment for it
  // (real finding, 2026-09-12 code review). Letting the matcher see it
  // fresh, same as any other transaction, lets it correctly become the
  // cycle's official payment (lastPaidDate/nextDueDate advance) when it
  // qualifies — which, having just supplied the pattern's own amount/
  // counterparty/date, it almost always does.
  //
  // Exactly one of these two actually does anything for a given pattern —
  // reassignTransactionsForPattern no-ops for a scheduled one (see its own
  // comment), matchPatternPayments only ever processes scheduled ones.
  await reassignTransactionsForPattern(pattern.id);
  await matchPatternPayments(session.user.householdId, pattern.id);

  if (sourceTransactionId) {
    const source = await db.transaction.findUnique({ where: { id: sourceTransactionId } });
    // Only step in if the matchers above didn't already claim it — a
    // guaranteed-link fallback, not the primary path, so it never clobbers
    // the cycle info (lastPaidDate/nextDueDate) a successful match just set.
    if (belongsToHousehold(source, session.user.householdId) && source.patternId === null) {
      await db.transaction.update({ where: { id: sourceTransactionId }, data: patternMatchData(pattern) });
    }
  }
  await matchReimbursements(session.user.householdId);

  revalidateHousehold();
  return {};
}

export async function updatePattern(
  patternId: string,
  _prev: PatternFormState,
  formData: FormData,
): Promise<PatternFormState> {
  const session = await requireFullAccess();

  const pattern = await db.recurringPattern.findUnique({ where: { id: patternId } });
  if (!belongsToHousehold(pattern, session.user.householdId)) return { error: "Not found." };

  const result = await parseCommon(session.user.householdId, formData);
  if ("error" in result) return { error: result.error };

  const updated = await db.recurringPattern.update({ where: { id: patternId }, data: result.data });
  // Transactions already claimed by this pattern follow its new
  // bucket/category too (2026-08-27 household rule) — reassignTransactionsForPattern
  // below only ever picks up not-yet-matched transactions.
  await db.transaction.updateMany({ where: { patternId }, data: patternMatchData(updated) });
  await reassignTransactionsForPattern(patternId);
  await matchPatternPayments(session.user.householdId, patternId);
  await matchReimbursements(session.user.householdId);

  revalidateHousehold();
  return {};
}

export async function deletePattern(patternId: string) {
  const session = await requireFullAccess();

  const pattern = await db.recurringPattern.findUnique({ where: { id: patternId } });
  if (!belongsToHousehold(pattern, session.user.householdId)) return;

  // Transactions this pattern claimed fall back to a neutral "transfer, not
  // spend or income" state rather than being left dangling — the household
  // can redefine a pattern for them, or reclassify manually, either way.
  await db.transaction.updateMany({
    where: { patternId },
    data: { patternId: null, isTransfer: true, isIncome: false, bucketId: null, debtId: null },
  });
  await db.recurringPattern.delete({ where: { id: patternId } });

  revalidateHousehold();
}

// The scheduled-pattern counterpart to deleteBill (src/app/bills/actions.ts)
// — same smart soft/hard split, same "Cancel" wording regardless of which
// path actually fires: a pattern already paid this period keeps its history
// and its already-matched transaction's bucket/category exactly as they are
// (only active flips false, so it stops being expected next cycle but stays
// visible — read-only, no further edits — through the rest of this month,
// per currentPeriodPatternWhere); one that hasn't been paid yet this period
// has nothing worth preserving, so it's simply removed the same way
// deletePattern already does. Only ever offered for a *scheduled* pattern
// (PatternRow) — the flat unscheduled rule card keeps plain deletePattern,
// since it has no real per-cycle lastPaidDate to protect.
export async function cancelPattern(patternId: string) {
  const session = await requireFullAccess();

  const pattern = await db.recurringPattern.findUnique({ where: { id: patternId } });
  if (!belongsToHousehold(pattern, session.user.householdId)) return;

  const { start: periodStart } = utcPeriodBounds(currentPeriodKey());
  const paidThisPeriod = pattern.lastPaidDate !== null && pattern.lastPaidDate >= periodStart;

  if (paidThisPeriod) {
    await db.recurringPattern.update({ where: { id: patternId }, data: { active: false } });
  } else {
    await db.transaction.updateMany({
      where: { patternId },
      data: { patternId: null, isTransfer: true, isIncome: false, bucketId: null, debtId: null },
    });
    await db.recurringPattern.delete({ where: { id: patternId } });
  }

  revalidateHousehold();
}

// The scheduled-pattern counterpart to skipBillCycle (src/app/bills/actions.ts)
// — a household knows this cycle owes nothing (a reimbursement that
// readjusted, a one-off month with no charge to pay back) and just moves the
// due date on, no payment recorded. Only ever offered once a cycle has sat
// overdue past SKIP_GRACE_DAYS with nothing matched (PatternRow) — unlike
// skipBillCycle's own gate, which this no longer matches (see
// PatternRow's SKIP_GRACE_DAYS comment): a bill can be skipped any time
// it isn't already paid/skipped, no day wait.
export async function skipPatternCycle(patternId: string) {
  const session = await requireFullAccess();

  const pattern = await db.recurringPattern.findUnique({ where: { id: patternId } });
  if (!belongsToHousehold(pattern, session.user.householdId)) return;
  if (!pattern.cadence || !pattern.nextDueDate) return; // defensive — unscheduled pattern has no cycle to skip

  await db.recurringPattern.update({
    where: { id: patternId },
    data: { nextDueDate: nextBillDueDate(pattern.cadence, pattern.nextDueDate, []) },
  });
  revalidateHousehold();
}

// --- Pattern payment review (see PatternPaymentReview's schema comment —
// mirrors DebtAmountReview/confirmDebtAmountChanged+declineDebtAmountChanged,
// src/app/debts/actions.ts, same shape) ---

// "Yes, this counts" — applies the pattern to the transaction the same way a
// real in-tolerance match would have, and advances the cycle. The review's
// own pattern is still sitting at the cycle that raised it (matchPatternPayments
// stops walking further cycles the moment a review is raised, see that
// file's own comment), so nextCycleDueDate is always derived from the
// pattern's own current nextDueDate, not the review's.
export async function confirmPatternPaymentReview(reviewId: string) {
  const session = await requireFullAccess();

  const review = await db.patternPaymentReview.findUnique({
    where: { id: reviewId },
    include: { pattern: true, transaction: { select: { occurredOn: true } } },
  });
  if (!belongsToHousehold(review, session.user.householdId)) return;
  if (!review.pattern.cadence || !review.pattern.nextDueDate) return; // defensive — shouldn't happen

  await db.transaction.update({ where: { id: review.transactionId }, data: patternMatchData(review.pattern) });
  await db.recurringPattern.update({
    where: { id: review.patternId },
    data: {
      lastPaidDate: review.transaction.occurredOn,
      nextDueDate: nextBillDueDate(review.pattern.cadence, review.pattern.nextDueDate, []),
    },
  });
  await db.patternPaymentReview.delete({ where: { id: reviewId } });

  revalidateHousehold();
}

// "No, just a payment" — clears the question without touching the
// transaction or the pattern's own cycle at all, same as declineDebtAmountChanged.
// Marks declinedAt rather than deleting the row (real fix, 2026-09-12 code
// review): the row's own transactionId @unique is what keeps
// raisePatternPaymentReview from re-flagging this same transaction — a
// hard delete freed that unique slot back up, so the very next sync
// re-found the identical non-qualifying transaction and raised an
// identical review again, forever, since nothing about the transaction or
// the pattern actually changed by declining. getPendingPatternPaymentReviews
// filters declinedAt: null so a declined row stays invisible everywhere a
// household would look, exactly as if it had been deleted.
export async function declinePatternPaymentReview(reviewId: string) {
  const session = await requireFullAccess();

  const review = await db.patternPaymentReview.findUnique({ where: { id: reviewId } });
  if (!belongsToHousehold(review, session.user.householdId)) return;

  await db.patternPaymentReview.update({ where: { id: reviewId }, data: { declinedAt: new Date() } });
  revalidateHousehold();
}

// --- Manual receipt linking (see src/lib/receipt-sync.ts) ---
// The human half of receipt→transaction matching: when matchReceipts can't
// place a parsed receipt on its own (Amazon's per-shipment charge totals,
// two equally-plausible charges), the household attaches it here. Modeled on
// linkReimbursement above — both sides household-checked, not trusted from
// the button that happened to render.

export async function linkReceiptToTransaction(
  receiptId: string,
  transactionId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireFullAccess();

  const [receipt, transaction, alreadyOnThisTxn] = await Promise.all([
    db.receipt.findUnique({ where: { id: receiptId } }),
    db.transaction.findUnique({ where: { id: transactionId } }),
    db.receipt.findUnique({ where: { transactionId } }),
  ]);
  if (!belongsToHousehold(receipt, session.user.householdId)) {
    return { ok: false, error: "That receipt is no longer available." };
  }
  if (!belongsToHousehold(transaction, session.user.householdId)) {
    return { ok: false, error: "That charge is no longer available." };
  }

  // This receipt got placed already (a sync auto-linked it between page load
  // and click) — nothing to do, and don't move it.
  if (receipt.transactionId && receipt.transactionId !== transactionId) {
    return { ok: false, error: "This receipt was just linked to another charge." };
  }

  // The charge already carries a different receipt. This one is almost
  // always the duplicate order email from the other mailbox — set it aside
  // rather than clobber the enrichment already on the charge, and say so
  // instead of just making the row vanish.
  if (alreadyOnThisTxn && alreadyOnThisTxn.id !== receiptId) {
    await db.receipt.update({ where: { id: receiptId }, data: { matchState: "STALE" } });
    revalidateHousehold();
    return {
      ok: false,
      error: "That charge already has a receipt — this looks like a duplicate email, so we set it aside.",
    };
  }

  await linkReceipt(receipt, transactionId);

  // Learn the alias when the household linked a charge the name-resemblance
  // matcher would have rejected (Classifieds.com → "Mountain Digital Media"), so the
  // next receipt from this party auto-links. Not for a person / P2P receipt
  // (those never gate on the name) or one that already resembled the payee.
  if (
    receipt.party &&
    !plausibleReceiptCharge(
      {
        kind: receipt.kind,
        party: receipt.party,
        partyIsPerson: receipt.partyIsPerson,
        p2pApp: receipt.p2pApp,
      },
      { merchant: transaction.merchant, rawDescription: transaction.rawDescription },
    )
  ) {
    const receiptParty = aliasKey(receipt.party);
    const merchantText = aliasKey(transaction.merchant);
    await db.receiptMerchantAlias.upsert({
      where: {
        householdId_receiptParty_merchantText: {
          householdId: session.user.householdId,
          receiptParty,
          merchantText,
        },
      },
      create: { householdId: session.user.householdId, receiptParty, merchantText },
      update: {},
    });
  }

  revalidateHousehold();
  return { ok: true };
}

// The multi-charge counterpart to linkReceiptToTransaction above — for a
// receipt whose stated total split across more than one bank transaction
// (Cedar Creek Irrigation's $35 bill + its own $2 online-payment fee, both
// posted separately, summing to one $37 receipt). See buildComboCandidates
// (src/app/settings/email/page.tsx) for how the picker finds these pairs,
// and Transaction.extraLegReceiptId's schema comment for why a second FK
// exists instead of Receipt.transactionId itself becoming a list.
export async function linkReceiptToTransactions(
  receiptId: string,
  transactionIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireFullAccess();

  if (transactionIds.length < 2) return { ok: false, error: "Pick at least two charges." };

  const [receipt, transactions, alreadyLinked] = await Promise.all([
    db.receipt.findUnique({ where: { id: receiptId } }),
    db.transaction.findMany({ where: { id: { in: transactionIds } } }),
    db.receipt.findMany({ where: { transactionId: { in: transactionIds } }, select: { id: true } }),
  ]);
  if (!belongsToHousehold(receipt, session.user.householdId)) {
    return { ok: false, error: "That receipt is no longer available." };
  }
  if (
    transactions.length !== transactionIds.length ||
    transactions.some((t) => t.householdId !== session.user.householdId)
  ) {
    return { ok: false, error: "One of those charges is no longer available." };
  }
  if (receipt.transactionId) {
    return { ok: false, error: "This receipt was just linked to another charge." };
  }
  if (transactions.some((t) => t.extraLegReceiptId) || alreadyLinked.some((r) => r.id !== receiptId)) {
    return { ok: false, error: "One of those charges already has a receipt — pick different ones." };
  }
  if (receipt.totalCents == null) {
    return { ok: false, error: "This receipt has no total to match." };
  }
  if (transactions.some((t) => !receiptSignMatches(receipt, t.amountCents))) {
    return { ok: false, error: "One of those charges doesn't match this receipt." };
  }
  const sum = transactions.reduce((s, t) => s + Math.abs(t.amountCents), 0);
  if (sum !== receipt.totalCents) {
    return { ok: false, error: "Those charges don't add up to the receipt total." };
  }

  await linkReceiptToTransactionLegs(receipt, transactionIds);

  revalidateHousehold();
  for (const t of transactions) {
    if (t.bucketId) revalidateHousehold();
  }
  return { ok: true };
}

// The manual counterpart to matchReceiptToBnplPlan — attach a purchase
// receipt that has no bank transaction (a BNPL order) to a tracked
// installment plan. Its itemization then lives on the plan (Debt), not a
// transaction.
export async function linkReceiptToPlanAction(
  receiptId: string,
  debtId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireFullAccess();

  const [receipt, debt] = await Promise.all([
    db.receipt.findUnique({ where: { id: receiptId } }),
    db.debt.findUnique({ where: { id: debtId }, include: { receipts: { select: { id: true } } } }),
  ]);
  if (!belongsToHousehold(receipt, session.user.householdId)) {
    return { ok: false, error: "That receipt is no longer available." };
  }
  if (!belongsToHousehold(debt, session.user.householdId)) {
    return { ok: false, error: "That plan is no longer available." };
  }
  if (receipt.transactionId || receipt.debtId) {
    return { ok: false, error: "This receipt was just linked to something else." };
  }
  if (debt.receipts.some((r) => r.id !== receiptId)) {
    return { ok: false, error: "That plan already has a receipt linked." };
  }

  await linkReceiptToPlan(receipt, debtId);
  revalidateHousehold();
  return { ok: true };
}

export async function dismissReceipt(receiptId: string) {
  const session = await requireFullAccess();

  const receipt = await db.receipt.findUnique({ where: { id: receiptId } });
  if (!belongsToHousehold(receipt, session.user.householdId)) return;

  await db.receipt.update({ where: { id: receiptId }, data: { matchState: "DISMISSED" } });
  revalidateHousehold();
}
