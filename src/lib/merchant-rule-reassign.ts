import { db } from "@/lib/db";
import { pickMerchantRule } from "@/lib/merchant-rules";

// Runs once, right after a bounded merchant rule is created or deleted —
// re-files the transactions that already synced in before the override
// existed. Mirrors reassignTransactionsForPattern's job: the per-sync sweep
// only ever touches never-categorized transactions, so a new "QuikStop under
// $15 -> Dining" rule wouldn't move the 40 snack runs already sitting in
// Fuel without this.
//
// Deliberately conservative about what it will move: a transaction for this
// merchant that's linked to a bill / debt / pattern / income, marked
// one-off, or hand-filed into some *other* bucket (one no rule for this
// merchant points at) is left exactly where it is. Only spend that's still
// sitting where a merchant rule would have put it gets re-evaluated.
export async function reassignTransactionsForMerchant(
  householdId: string,
  merchant: string,
  // Buckets to re-check beyond the ones current rules target — used when a
  // bounded rule is *deleted*, so the transactions it had pulled into its
  // now-gone bucket get re-evaluated against the base rule.
  extraBucketIds: string[] = [],
): Promise<number> {
  const key = merchant.trim().toLowerCase();
  if (!key) return 0;

  const [rules, buckets, categories] = await Promise.all([
    db.merchantRule.findMany({ where: { householdId, merchant: key } }),
    db.bucket.findMany({ where: { householdId }, select: { id: true, trackingMode: true } }),
    db.billCategory.findMany({ where: { householdId }, select: { id: true, bucketId: true } }),
  ]);
  if (rules.length === 0) return 0;

  const bucketMode = new Map(buckets.map((b) => [b.id, b.trackingMode]));
  // Buckets any rule for this merchant targets — the set a transaction can
  // currently sit in and still be considered "rule-managed" rather than a
  // deliberate manual placement elsewhere.
  const ruleBucketIds = new Set(
    [...rules.map((r) => r.bucketId), ...extraBucketIds].filter((id): id is string => Boolean(id)),
  );

  const candidates = await db.transaction.findMany({
    where: {
      householdId,
      merchant: { equals: key, mode: "insensitive" },
      oneOff: false,
      billId: null,
      debtId: null,
      debtPaymentId: null,
      patternId: null,
      incomeId: null,
      OR: [
        { bucketId: null },
        { isTransfer: true },
        { isIncome: true },
        ...(ruleBucketIds.size > 0 ? [{ bucketId: { in: [...ruleBucketIds] } }] : []),
      ],
    },
    select: {
      id: true,
      amountCents: true,
      bucketId: true,
      categoryId: true,
      account: { select: { budgetTracked: true } },
    },
  });

  let count = 0;
  for (const t of candidates) {
    // A non-budget-tracked account's spend never belongs in a bucket (see
    // Account.budgetTracked) — the sync pipeline skips it, so the sweep must
    // too. A manual entry has no account and is always eligible.
    if (t.account && !t.account.budgetTracked) continue;
    const rule = pickMerchantRule(rules, t.amountCents);
    if (!rule?.bucketId || bucketMode.get(rule.bucketId) === "RECURRING") continue;
    if (rule.bucketId === t.bucketId) continue;

    const categoryId =
      rule.categoryId && categories.find((c) => c.id === rule.categoryId)?.bucketId === rule.bucketId
        ? rule.categoryId
        : null;

    await db.transaction.update({
      where: { id: t.id },
      data: {
        bucketId: rule.bucketId,
        categoryId,
        aiSuggestedBucketId: null,
        aiSuggestedCategoryId: null,
        isTransfer: false,
        isIncome: false,
      },
    });
    count++;
  }
  return count;
}
