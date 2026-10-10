import { db } from "@/lib/db";
import { belongsToHousehold } from "@/lib/access-rules";
export { pickMerchantRule, type RuleForPick } from "@/lib/merchant-rule-pick";

// An amount-routing rule points a merchant at a bucket only for charges on
// one side of a threshold: "under $X" stores the window [0, X]; "over $X"
// stores [X, ROUTING_OVER_MAX_CENTS] — a real integer well under Postgres
// INT_MAX (~$21.4M) that no real charge will reach, so pickMerchantRule
// (which needs a non-null max to treat a row as a bounded override) still
// recognises it.
export const ROUTING_OVER_MAX_CENTS = 2_000_000_000;

export type RoutingDirection = "under" | "over";

// The [min, max] window a "route <merchant> {under|over} $threshold here"
// rule stores. `direction === "over"` is detected back out of a stored row by
// amountMinCents > 0 (see setAmountRoutingRule / the bucket-settings list).
export function routingBounds(
  direction: RoutingDirection,
  thresholdCents: number,
): { amountMinCents: number; amountMaxCents: number } {
  return direction === "over"
    ? { amountMinCents: thresholdCents, amountMaxCents: ROUTING_OVER_MAX_CENTS }
    : { amountMinCents: 0, amountMaxCents: thresholdCents };
}

export type MerchantRuleData = {
  bucketId: string | null;
  debtId: string | null;
  // The learned subcategory for this merchant, parallel to bucketId — see
  // the schema comment on MerchantRule.categoryId. Every call site passes
  // null when no category is known/relevant (a debt-payment or income
  // classification, or a P2P merchant, which never gets a rule at all).
  categoryId: string | null;
  isTransfer: boolean;
  isIncome: boolean;
};

// Upserts the household's memory of "what is this merchant" — called both
// when a human confirms a classification (confidence 1, source USER) and
// when AI guesses one (confidence = AI's own score, source AI, even below
// the auto-file threshold). A USER confirmation always wins over a prior AI
// guess for the same merchant; an AI guess never downgrades a prior USER rule.
//
// Only ever touches the merchant's *base* rule (NULL/NULL bounds). Bounded
// overrides (setBoundedMerchantRule) are a separate, human-only layer.
export async function upsertMerchantRule(
  householdId: string,
  merchant: string,
  data: MerchantRuleData,
  opts: { confidence: number; source: "USER" | "AI" },
): Promise<void> {
  const key = merchant.trim().toLowerCase();
  if (!key) return;

  const existing = await db.merchantRule.findFirst({
    where: { householdId, merchant: key, amountMinCents: null, amountMaxCents: null },
    select: { id: true, source: true },
  });
  if (existing?.source === "USER" && opts.source === "AI") return;

  if (existing) {
    await db.merchantRule.update({
      where: { id: existing.id },
      data: { ...data, confidence: opts.confidence, source: opts.source },
    });
  } else {
    await db.merchantRule.create({
      data: { householdId, merchant: key, ...data, confidence: opts.confidence, source: opts.source },
    });
  }
}

// The human-only override layer: "only send <merchant> here when the charge
// is within this window." Always source USER / confidence 1 / managedByUser.
// One row per (merchant, min, max) — re-saving the same window updates it.
export async function setBoundedMerchantRule(
  householdId: string,
  merchant: string,
  bounds: { amountMinCents: number; amountMaxCents: number },
  target: { bucketId: string; categoryId: string | null },
): Promise<void> {
  const key = merchant.trim().toLowerCase();
  if (!key) return;

  const existing = await db.merchantRule.findFirst({
    where: {
      householdId,
      merchant: key,
      amountMinCents: bounds.amountMinCents,
      amountMaxCents: bounds.amountMaxCents,
    },
    select: { id: true },
  });

  const data = {
    bucketId: target.bucketId,
    debtId: null,
    categoryId: target.categoryId,
    isTransfer: false,
    isIncome: false,
    confidence: 1,
    source: "USER",
    managedByUser: true,
    amountMinCents: bounds.amountMinCents,
    amountMaxCents: bounds.amountMaxCents,
  };

  if (existing) {
    await db.merchantRule.update({ where: { id: existing.id }, data });
  } else {
    await db.merchantRule.create({ data: { householdId, merchant: key, ...data } });
  }
}

export async function deleteBoundedMerchantRule(
  householdId: string,
  id: string,
): Promise<{ merchant: string; bucketId: string | null } | null> {
  const rule = await db.merchantRule.findUnique({ where: { id } });
  // Guard: household-scoped, and never let this delete a base rule.
  if (!belongsToHousehold(rule, householdId) || rule.amountMinCents == null) return null;
  await db.merchantRule.delete({ where: { id } });
  return { merchant: rule.merchant, bucketId: rule.bucketId };
}
