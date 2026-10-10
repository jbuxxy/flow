"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { belongsToHousehold, hasFullAccess, requireFullAccess } from "@/lib/access";
import { parseDollarsToCents } from "@/lib/money";
import { checkAndSendBucketAlerts } from "@/lib/buckets";
import {
  upsertMerchantRule,
  setBoundedMerchantRule,
  deleteBoundedMerchantRule,
  routingBounds,
  type RoutingDirection,
} from "@/lib/merchant-rules";
import { reassignTransactionsForMerchant } from "@/lib/merchant-rule-reassign";
import { previewRoutingRule, type RoutingRulePreview } from "@/lib/routing-rules";
import { isP2PMerchant } from "@/lib/p2p-keywords";
import { isGenericCardPaymentDescriptor } from "@/lib/debt-payment-pattern";
import { dismissUnlabeledP2P } from "@/lib/p2p-transfers";

const createBucketSchema = z.object({
  name: z.string().trim().min(1).max(60),
  monthlyCap: z.string(),
  trackingMode: z.enum(["SPEND", "RECURRING", "MIXED"]),
  // Same "on"/undefined checkbox convention as updateBucketSettings
  // (buckets/[id]/actions.ts) — a browser checkbox with no explicit value
  // submits "on" when checked, nothing at all when unchecked.
  excludedFromAllocation: z.enum(["on"]).optional(),
  // One-time-purchase buckets repurpose this as "notify me when this
  // payment is made" (the form hides every other alert checkbox for them
  // — see add-bucket-form.tsx) rather than exposing a second field.
  transactionAlertEnabled: z.enum(["on"]).optional(),
});

export type CreateBucketState = { error?: string };

export async function createBucket(
  _prev: CreateBucketState,
  formData: FormData,
): Promise<CreateBucketState> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const parsed = createBucketSchema.safeParse({
    name: formData.get("name"),
    monthlyCap: formData.get("monthlyCap"),
    trackingMode: formData.get("trackingMode"),
    excludedFromAllocation: formData.get("excludedFromAllocation") ?? undefined,
    transactionAlertEnabled: formData.get("transactionAlertEnabled") ?? undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const cents = parseDollarsToCents(parsed.data.monthlyCap);
  if (cents === null) {
    return { error: "Enter a valid budget amount." };
  }

  const maxSort = await db.bucket.aggregate({
    where: { householdId: session.user.householdId },
    _max: { sortOrder: true },
  });

  await db.bucket.create({
    data: {
      householdId: session.user.householdId,
      name: parsed.data.name,
      monthlyCapCents: cents,
      trackingMode: parsed.data.trackingMode,
      excludedFromAllocation: parsed.data.excludedFromAllocation === "on",
      transactionAlertEnabled: parsed.data.transactionAlertEnabled === "on",
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
  });

  revalidatePath("/buckets");
  return {};
}

// Purely descriptive — unlike reassignTransaction, never touches
// bucketId/debtId/isIncome/isTransfer/patternId. Editable any time, on any
// transaction, independent of how (or whether) it's classified.
//
// A transaction linked to an INSTALLMENT (BNPL) debt or a RecurringPattern
// doesn't get its own stored label at all — it defers entirely to that
// plan's own label (Debt.label / RecurringPattern.label), which is also
// what every sibling payment in the same plan reads (see the effective-label
// precedence in transactions/page.tsx and buckets/[id]/page.tsx). This is a
// single source of truth, not a synced copy (2026-08-25 consolidation,
// replacing an earlier design that backfilled a separate Transaction.label
// per payment): editing "installment 3 of 4" here immediately shows on 1 and
// 2 too, because they all read the same underlying field.
// A REVOLVING card/loan's debtId is deliberately NOT included — it spans
// that debt's entire payment history, so writing there would mean this same
// label applies to every past/future payment on the card. RecurringPattern's
// label is also its required identifying name (shown in dropdowns/edit
// forms elsewhere), so an empty save there is a no-op rather than blanking
// it — plain Transaction.label has no such constraint.
export async function updateTransactionLabel(transactionId: string, label: string) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const transaction = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!belongsToHousehold(transaction, session.user.householdId)) return;

  const trimmed = label.trim().slice(0, 120);

  if (transaction.patternId) {
    if (trimmed) await db.recurringPattern.update({ where: { id: transaction.patternId }, data: { label: trimmed } });
  } else {
    const debt = transaction.debtId ? await db.debt.findUnique({ where: { id: transaction.debtId }, select: { debtType: true } }) : null;
    if (debt?.debtType === "INSTALLMENT") {
      await db.debt.update({ where: { id: transaction.debtId! }, data: { label: trimmed || null } });
    } else {
      await db.transaction.update({ where: { id: transactionId }, data: { label: trimmed || null } });
    }
  }

  revalidatePath("/buckets");
  if (transaction.bucketId) revalidatePath(`/buckets/${transaction.bucketId}`);
  revalidatePath("/debts");
  revalidatePath("/transactions");
  revalidatePath("/bills");
}

// Single entry point for changing what a transaction is: a spending bucket,
// a payment toward a tracked debt, a one-off income credit, or a generic
// transfer — always mutually exclusive (assigning one clears the rest,
// including patternId, per the classification convention in WORKING_ON.md).
// Works on both never-categorized transactions and ones that were already
// filed somewhere, so a miscategorized bucket transaction can be moved to a
// debt (or income, or transfer) just as easily as an uncategorized one can
// be assigned. Used by both the per-bucket transaction list and the
// household-wide /transactions page.
export async function reassignTransaction(
  transactionId: string,
  // categoryId is bucket-branch-only (a spend concept, not meaningful for a
  // debt payment or income transaction — see the schema comment on
  // Transaction.categoryId), and required rather than optional so every call
  // site makes an explicit choice (null for "no category") — same
  // unconditional-reset convention every other field in this branch already
  // follows (debtId/isTransfer/isIncome/patternId etc. below), rather than a
  // partial-update ambiguity over whether omitting it means "leave alone" or
  // "clear."
  target: { bucketId: string; categoryId: string | null } | { debtId: string } | { income: true },
  // Whether this assignment should also (re)write the household-wide
  // MerchantRule for the merchant. Left undefined by the confirmation flows
  // (the "Needs a Bucket" queue, accepting an AI suggestion, a first-time
  // assignment) — those DO want to teach the rule, and the default below
  // learns whenever the transaction wasn't already committed to a different
  // bucket. The Move panel passes it explicitly: `false` for a plain
  // correction of one transaction (a merchant like Amazon/Walmart legitimately
  // spans many buckets — silently repointing the whole household's rule off
  // one charge just makes it guess wrong next time), `true` only when the
  // household ticks "make this the rule."
  opts?: { learnRule?: boolean },
) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const transaction = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { account: { select: { budgetTracked: true } } },
  });
  if (!belongsToHousehold(transaction, session.user.householdId)) return;

  // Every P2P app shares the same generic merchant text ("Venmo", "Zelle")
  // across totally unrelated payments — writing a household-wide
  // MerchantRule off one of them would misclassify every future P2P
  // transaction the same way, whatever this one turns out to be (same
  // reasoning as assignTransferOnce, formerly src/app/transfers/actions.ts).
  // Unless a receipt email resolved the counterparty to a BUSINESS — then
  // the rule is keyed on that party ("Jane's Dog Walking"), which IS safe
  // and is how a P2P charge becomes a learnable merchant. A payment resolved
  // to a PERSON stays no-rule: a friend-to-friend payment could be for
  // anything, so it's classified one transaction at a time.
  const resolvedBusiness =
    transaction.resolvedMerchant && !transaction.resolvedMerchantIsPerson
      ? transaction.resolvedMerchant.trim()
      : null;
  const ruleMerchant = resolvedBusiness || transaction.merchant;
  const isP2P =
    !resolvedBusiness &&
    isP2PMerchant(transaction.merchant);

  if ("bucketId" in target) {
    // A non-budget-tracked account's spend (see Account.budgetTracked) must
    // never land in a bucket, manual reassignment included — the auto
    // pipeline already skips it (categorizeUncategorizedTransactions in
    // simplefin-sync.ts), and the reclassify UI hides the Bucket option for
    // it (src/app/transactions/transaction-row.tsx), but this guard is the
    // one place that actually enforces it server-side.
    if (transaction.account && !transaction.account.budgetTracked) return;

    const bucket = await db.bucket.findUnique({ where: { id: target.bucketId } });
    if (!belongsToHousehold(bucket, session.user.householdId)) return;
    // A RECURRING bucket must never get bucketId set directly — see the
    // schema comment on Bucket.trackingMode: it can only ever be reached by
    // becoming a tracked RecurringBill (createBillFromTransaction/
    // acceptBillSuggestion). The auto-categorization pipeline already
    // respects this (autoAssignableBucketIds, simplefin-sync.ts); this is
    // the manual-assign counterpart to that guard. Every caller (the "Needs
    // a bucket" queue, /transactions' reclassify, a bucket page's own
    // reclassify) already excludes RECURRING buckets from what it offers, so
    // this should never actually fire — it's the same defense-in-depth
    // convention as the budgetTracked guard just above.
    if (bucket.trackingMode === "RECURRING") return;

    // Ownership- and bucket-checked the same way bucketId is just above, not
    // just trusted from the caller — a category picker only ever offers
    // categories scoped to whichever bucket is currently selected (see
    // BillCategory.bucketId), but this is the one place that actually
    // enforces both server-side. A category belonging to some other bucket
    // is silently dropped rather than erroring, same "just don't apply it"
    // convention as an unrecognized id anywhere else in this action.
    let categoryId: string | null = null;
    if (target.categoryId) {
      const category = await db.billCategory.findUnique({ where: { id: target.categoryId } });
      if (category && category.householdId === session.user.householdId && category.bucketId === bucket.id) {
        categoryId = category.id;
      }
    }

    await db.transaction.update({
      where: { id: transactionId },
      data: {
        bucketId: bucket.id,
        categoryId,
        aiSuggestedCategoryId: null,
        debtId: null,
        isTransfer: false,
        isIncome: false,
        patternId: null,
        aiSuggestedBucketId: null,
        // A stale debtPaymentId/incomeId from a prior (possibly wrong)
        // classification must never survive a manual move — unlike billId
        // (which legitimately coexists with bucketId, see
        // matchBillPayments), a debt-payment or income link only makes
        // sense alongside the classification that produced it. Leaving one
        // behind is exactly the bug that let a Kids' Activities Venmo
        // payment keep showing as satisfying an unrelated credit card's
        // minimum payment after being manually rebucketed.
        debtPaymentId: null,
        incomeId: null,
        // A manual bucket choice is final — the receipt-driven reclass
        // (src/lib/receipt-reclassify.ts) must never fight it.
        receiptReclassAt: new Date(),
      },
    });
    await checkAndSendBucketAlerts(bucket.id);
    // Default: learn the rule unless this is a move of a transaction that was
    // already committed to a different bucket (see the `opts` comment above).
    // Never for a one-time-purchase bucket: a "Tesla" rule would then silently
    // claim every future Tesla charge (insurance, service, Supercharging) —
    // the exact reason the sync-time matcher (one-time-bucket-match.ts) skips
    // MerchantRules for these too.
    const learnRule =
      !bucket.excludedFromAllocation &&
      (opts?.learnRule ?? !(transaction.bucketId != null && transaction.bucketId !== bucket.id));
    if (!isP2P && learnRule) {
      await upsertMerchantRule(
        session.user.householdId,
        ruleMerchant,
        { bucketId: bucket.id, debtId: null, categoryId, isTransfer: false, isIncome: false },
        { confidence: 1, source: "USER" },
      );
    }
    revalidatePath("/buckets");
    revalidatePath(`/buckets/${bucket.id}`);
    revalidatePath("/transactions");
    if (transaction.bucketId && transaction.bucketId !== bucket.id) {
      revalidatePath(`/buckets/${transaction.bucketId}`);
    }
  } else if ("debtId" in target) {
    // Debts are one of the sections a BUCKETS_ONLY member is specifically
    // scoped away from (see the DashboardScope comment in schema.prisma) —
    // the bucketId branch above is this same action's normal path for them,
    // but filing a transaction as a debt payment reaches Debt data they
    // otherwise never see at all, so it needs its own check rather than
    // inheriting the bucketId branch's household-only scoping.
    if (!hasFullAccess(session.user)) return;
    const debt = await db.debt.findUnique({ where: { id: target.debtId } });
    if (!belongsToHousehold(debt, session.user.householdId)) return;

    await db.transaction.update({
      where: { id: transactionId },
      data: {
        debtId: debt.id,
        isTransfer: true,
        bucketId: null,
        categoryId: null,
        aiSuggestedCategoryId: null,
        isIncome: false,
        patternId: null,
        aiSuggestedBucketId: null,
        // This is the manual one-off "counts as a payment toward this
        // debt" override, not a matched DebtPayment cycle — any prior
        // debtPaymentId/billId/incomeId is now stale regardless of whether
        // it's the same debt as before.
        debtPaymentId: null,
        billId: null,
        incomeId: null,
      },
    });
    // A generic issuer payment descriptor ("Capital One Credit Card Payment")
    // names no specific card — every card at that issuer, and an untracked
    // spouse's card, posts the identical string, so a household-wide rule off
    // it silently misfiles them all onto this one debt (real incident,
    // 2026-09-01). This one transaction is still linked to the debt above;
    // future ones are attributed per-transaction by the sync categorizer
    // (unique minimum-payment match, or an offsetting card-side leg).
    if (!isP2P && !isGenericCardPaymentDescriptor(ruleMerchant)) {
      await upsertMerchantRule(
        session.user.householdId,
        ruleMerchant,
        { bucketId: null, debtId: debt.id, categoryId: null, isTransfer: true, isIncome: false },
        { confidence: 1, source: "USER" },
      );
    }
    revalidatePath("/buckets");
    revalidatePath("/debts");
    revalidatePath("/transactions");
    if (transaction.bucketId) revalidatePath(`/buckets/${transaction.bucketId}`);
  } else {
    // Same reasoning as the debtId branch above — income is also scoped
    // away from a BUCKETS_ONLY member.
    if (!hasFullAccess(session.user)) return;
    await db.transaction.update({
      where: { id: transactionId },
      data: {
        isIncome: true,
        isTransfer: false,
        bucketId: null,
        categoryId: null,
        aiSuggestedCategoryId: null,
        debtId: null,
        patternId: null,
        aiSuggestedBucketId: null,
        // A one-off "counts as income" flag, not a link to a tracked Income
        // record (see createIncomeFromTransaction for that) — any prior
        // debtPaymentId/billId/incomeId is stale now that this is income.
        debtPaymentId: null,
        billId: null,
        incomeId: null,
        // A P2P credit marked income this way is otherwise still a match
        // for getUnlabeledP2PTransfers' OR clause (isIncome:true is one of
        // its own conditions) — without oneOff:true it would never drop out
        // of the unlabeled-P2P queue despite being fully classified.
        oneOff: true,
      },
    });
    if (!isP2P) {
      await upsertMerchantRule(
        session.user.householdId,
        ruleMerchant,
        { bucketId: null, debtId: null, categoryId: null, isTransfer: false, isIncome: true },
        { confidence: 1, source: "USER" },
      );
    }
    revalidatePath("/buckets");
    revalidatePath("/income");
    revalidatePath("/transactions");
    if (transaction.bucketId) revalidatePath(`/buckets/${transaction.bucketId}`);
  }
}

export type AmountRoutingState = { error?: string };

// Creates (or updates) an amount-bounded merchant rule: "only send
// <merchant> into <bucketId> when the charge is $<amountDollars> or less"
// (direction "under") / "or more" (direction "over"). Charges on the other
// side of the threshold keep flowing wherever the merchant's base rule
// points, so one merchant can split by size (QuikStop snack runs -> Dining,
// fill-ups -> Fuel). Sweeps the merchant's already-synced transactions so
// history re-files too, not just future charges.
//
// `merchant` comes straight off a transaction the caller is looking at — no
// ownership concept of its own, it's just a label string; the bucket and
// category are the household-scoped things that get checked.
export async function setAmountRoutingRule(input: {
  merchant: string;
  bucketId: string;
  categoryId: string | null;
  amountDollars: string;
  direction?: RoutingDirection;
}): Promise<AmountRoutingState> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const merchant = input.merchant.trim();
  if (!merchant) return { error: "No merchant to route." };

  // Same reasoning as reassignTransaction's isP2P guard — a bare
  // "Venmo"/"PayPal" rule would capture every unrelated P2P payment.
  if (isP2PMerchant(merchant)) {
    return { error: "Amount routing isn't available for peer-to-peer payment apps." };
  }

  const direction: RoutingDirection = input.direction === "over" ? "over" : "under";
  const thresholdCents = parseDollarsToCents(input.amountDollars);
  if (thresholdCents === null || thresholdCents <= 0) return { error: "Enter an amount above $0." };

  const bucket = await db.bucket.findUnique({ where: { id: input.bucketId } });
  if (!belongsToHousehold(bucket, session.user.householdId)) return { error: "Bucket not found." };
  if (bucket.trackingMode === "RECURRING") return { error: "Pick a bucket that tracks single purchases." };

  let categoryId: string | null = null;
  if (input.categoryId) {
    const category = await db.billCategory.findUnique({ where: { id: input.categoryId } });
    if (category && category.householdId === session.user.householdId && category.bucketId === bucket.id) {
      categoryId = category.id;
    }
  }

  await setBoundedMerchantRule(
    session.user.householdId,
    merchant,
    routingBounds(direction, thresholdCents),
    { bucketId: bucket.id, categoryId },
  );
  await reassignTransactionsForMerchant(session.user.householdId, merchant);
  await checkAndSendBucketAlerts(bucket.id);

  revalidatePath("/buckets");
  revalidatePath(`/buckets/${bucket.id}`);
  revalidatePath("/transactions");
  return {};
}

// Edits an existing amount-bounded rule in place — the threshold, the
// destination bucket, or both — from the "Amount Routing" list in bucket
// settings. Keeps the same row (and its 0/maxCents window key) rather than
// routing through setBoundedMerchantRule, whose (merchant, min, max) select
// would treat a changed threshold as a brand-new rule and leave the old one
// behind. Re-sweeps history the same way create/remove do.
export async function updateAmountRoutingRule(input: {
  ruleId: string;
  bucketId: string;
  amountDollars: string;
}): Promise<AmountRoutingState> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const rule = await db.merchantRule.findUnique({ where: { id: input.ruleId } });
  // amountMinCents != null is the "is a bounded override" check — never let
  // this touch a merchant's base rule.
  if (!belongsToHousehold(rule, session.user.householdId) || rule.amountMinCents == null) {
    return { error: "Rule not found." };
  }

  const thresholdCents = parseDollarsToCents(input.amountDollars);
  if (thresholdCents === null || thresholdCents <= 0) return { error: "Enter an amount above $0." };

  // An "over $X" rule stores [X, ROUTING_OVER_MAX_CENTS] — editing its
  // threshold moves the min edge, not the (sentinel) max. "under $X" stores
  // [0, X] and moves the max edge, as before.
  const bounds =
    rule.amountMinCents > 0
      ? { amountMinCents: thresholdCents }
      : { amountMaxCents: thresholdCents };

  const bucket = await db.bucket.findUnique({ where: { id: input.bucketId } });
  if (!belongsToHousehold(bucket, session.user.householdId)) return { error: "Bucket not found." };
  if (bucket.trackingMode === "RECURRING") return { error: "Pick a bucket that tracks single purchases." };

  // Categories are bucket-scoped — a stored one only stays valid if the
  // destination bucket isn't changing.
  const categoryId = input.bucketId === rule.bucketId ? rule.categoryId : null;

  const movedAway = rule.bucketId && rule.bucketId !== bucket.id ? [rule.bucketId] : [];

  await db.merchantRule.update({
    where: { id: rule.id },
    data: { ...bounds, bucketId: bucket.id, categoryId },
  });
  // Pass the old destination as an extra so charges this rule had pulled
  // there get re-evaluated now that it points elsewhere (same reasoning as
  // removeAmountRoutingRule).
  await reassignTransactionsForMerchant(session.user.householdId, rule.merchant, movedAway);
  await checkAndSendBucketAlerts(bucket.id);

  revalidatePath("/buckets");
  revalidatePath(`/buckets/${bucket.id}`);
  if (rule.bucketId && rule.bucketId !== bucket.id) revalidatePath(`/buckets/${rule.bucketId}`);
  revalidatePath("/transactions");
  return {};
}

export async function removeAmountRoutingRule(ruleId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const deleted = await deleteBoundedMerchantRule(session.user.householdId, ruleId);
  if (!deleted) return;

  // History this rule had pulled into its bucket now falls back to the base
  // rule — pass that bucket so the sweep actually revisits those rows.
  await reassignTransactionsForMerchant(
    session.user.householdId,
    deleted.merchant,
    deleted.bucketId ? [deleted.bucketId] : [],
  );
  revalidatePath("/buckets");
  revalidatePath("/transactions");
}

// --- Plain-language amount-routing rule authoring ---

export async function previewRoutingRuleAction(
  fromBucketId: string,
  text: string,
): Promise<{ preview: RoutingRulePreview | null; error: string | null }> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const fromBucket = await db.bucket.findUnique({ where: { id: fromBucketId }, select: { householdId: true } });
  if (!belongsToHousehold(fromBucket, session.user.householdId)) {
    return { preview: null, error: "Bucket not found." };
  }
  return previewRoutingRule(session.user.householdId, text, fromBucketId);
}

export type ApplyRoutingRuleInput = {
  fromBucketId: string;
  maxCents: number;
  merchants: string[];
  backfill: boolean;
  target:
    | { kind: "existing"; bucketId: string }
    | { kind: "new"; name: string; capCents: number; adjustments: { bucketId: string; capCents: number }[] };
};

export async function applyRoutingRuleAction(input: ApplyRoutingRuleInput): Promise<AmountRoutingState> {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const householdId = session.user.householdId;

  const fromBucket = await db.bucket.findUnique({ where: { id: input.fromBucketId }, select: { householdId: true } });
  if (!belongsToHousehold(fromBucket, householdId)) return { error: "Bucket not found." };

  if (!Number.isInteger(input.maxCents) || input.maxCents <= 0) return { error: "Enter an amount above $0." };

  // Only merchants that actually exist in this household's history, and
  // never a generic P2P name.
  const cleaned = [...new Set(input.merchants.map((m) => m.trim()).filter(Boolean))];
  if (cleaned.length === 0) return { error: "No merchants selected." };
  if (cleaned.some((m) => isP2PMerchant(m))) {
    return { error: "Amount routing isn't available for peer-to-peer payment apps." };
  }
  const real = await db.transaction.findMany({
    where: { householdId, merchant: { in: cleaned, mode: "insensitive" } },
    select: { merchant: true },
    distinct: ["merchant"],
  });
  const merchants = real.map((r) => r.merchant);
  if (merchants.length === 0) return { error: "Those merchants aren't in your transaction history." };

  // Resolve the destination bucket, creating it (and rebalancing caps) when
  // the proposal called for a new one.
  let targetBucketId: string;
  if (input.target.kind === "existing") {
    const b = await db.bucket.findUnique({ where: { id: input.target.bucketId } });
    if (!belongsToHousehold(b, householdId)) return { error: "Destination bucket not found." };
    if (b.trackingMode === "RECURRING") return { error: "Pick a bucket that tracks single purchases." };
    targetBucketId = b.id;
  } else {
    const name = input.target.name.trim().slice(0, 60);
    if (!name) return { error: "The new bucket needs a name." };
    if (!Number.isInteger(input.target.capCents) || input.target.capCents < 0) return { error: "Enter a valid budget for the new bucket." };

    // Apply the cap adjustments first so a mid-operation failure doesn't
    // leave a new bucket with no funding story.
    for (const adj of input.target.adjustments) {
      const b = await db.bucket.findUnique({ where: { id: adj.bucketId } });
      if (!belongsToHousehold(b, householdId)) return { error: "A bucket being rebalanced wasn't found." };
      if (!Number.isInteger(adj.capCents) || adj.capCents < 0) return { error: "Enter a valid adjusted budget." };
      await db.bucket.update({ where: { id: b.id }, data: { monthlyCapCents: adj.capCents } });
    }

    const maxSort = await db.bucket.aggregate({ where: { householdId }, _max: { sortOrder: true } });
    const created = await db.bucket.create({
      data: {
        householdId,
        name,
        monthlyCapCents: input.target.capCents,
        trackingMode: "SPEND",
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    });
    targetBucketId = created.id;
  }

  for (const merchant of merchants) {
    await setBoundedMerchantRule(
      householdId,
      merchant,
      { amountMinCents: 0, amountMaxCents: input.maxCents },
      { bucketId: targetBucketId, categoryId: null },
    );
    if (input.backfill) {
      await reassignTransactionsForMerchant(householdId, merchant, [input.fromBucketId]);
    }
  }
  await checkAndSendBucketAlerts(targetBucketId);

  revalidatePath("/buckets");
  revalidatePath("/transactions");
  revalidatePath(`/buckets/${targetBucketId}`);
  revalidatePath(`/buckets/${input.fromBucketId}`);
  return {};
}

export async function dismissUnlabeledP2PDebits() {
  // Only ever rendered for a full-access member on /buckets (see
  // buckets/page.tsx) — an unlabeled P2P debit can resolve to a debt payment
  // or income, both outside a BUCKETS_ONLY member's scope.
  const session = await requireFullAccess();
  await dismissUnlabeledP2P(session.user.householdId, "DEBIT");
  revalidatePath("/buckets");
  revalidatePath("/");
}
