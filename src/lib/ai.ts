// Household-configurable AI client — see src/lib/ai-provider.ts for the
// actual provider dispatch (Gemini/OpenAI/Anthropic/Grok). Every caller must
// tolerate this returning an empty result (no provider configured, rate
// limit, network blip): AI categorization is a nice-to-have on top of
// merchant-memory, never a hard requirement for sync to succeed.

import { getHouseholdAiConfig, callText, callJson, type AiProviderConfig } from "@/lib/ai-provider";
import { dollarsToCents, formatCents } from "@/lib/money";
import type { ReceiptKind } from "@prisma/client";

export type BucketSuggestion = { bucketName: string | null; confidence: number };

// The {"results": [...]} envelope every batched structured-output call
// here asks for, around one result item's schema.
function resultsSchema(items: object) {
  return {
    type: "object",
    properties: { results: { type: "array", items } },
    required: ["results"],
    additionalProperties: false,
  };
}

// Maps a name the model returned back to the household's own spelling,
// case-insensitively — null when it isn't one of `names`.
function nameLookup(names: string[]): (raw: string | null | undefined) => string | null {
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n] as const));
  return (raw) => (raw ? (byLower.get(raw.toLowerCase()) ?? null) : null);
}

// A model-reported confidence, coerced into [0, 1].
function clampConfidence(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

// Shared by suggestBucketsForMerchants and suggestBucketsFromReceipts below
// (real finding, 2026-09-22 code review: the two had each hand-copied the
// same hint-suffix line and the same case-insensitive match/confidence-clamp
// loop) — one place to fix a bucket-name-matching or confidence-clamping bug
// instead of two.
function bucketHintLines(buckets: { name: string; aiInstructions?: string | null }[]): string[] {
  return buckets.map((b) => (b.aiInstructions ? `${b.name} — hint: ${b.aiInstructions}` : b.name));
}

function resolveBucketSuggestions(
  buckets: { name: string }[],
  results: { key: string; bucketName: string | null; confidence: number }[],
): Map<string, BucketSuggestion> {
  const bucketNamed = nameLookup(buckets.map((b) => b.name));
  const result = new Map<string, BucketSuggestion>();
  for (const entry of results) {
    result.set(entry.key, {
      bucketName: bucketNamed(entry.bucketName),
      confidence: clampConfidence(entry.confidence),
    });
  }
  return result;
}

// Batches every unmatched merchant into a single AI call per sync rather
// than one call per transaction — cheaper and avoids rate limits. Amount is
// included per merchant (not just the name) because cadence/name alone can't
// tell a $9.99 Netflix charge from a $1,790 mortgage payment that happens to
// also repeat monthly — without a dollar figure, the model has no way to
// catch that a "Subscriptions" guess makes no sense at loan/mortgage scale.
// Real incident: a fresh reclassification test misfiled an SHL mortgage
// payment and Chase Credit Card payment as "Subscriptions" before this was
// added.
export async function suggestBucketsForMerchants(
  householdId: string,
  merchants: { merchant: string; amountCents: number }[],
  buckets: { id: string; name: string; aiInstructions?: string | null }[],
): Promise<Map<string, BucketSuggestion>> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config || merchants.length === 0 || buckets.length === 0) return new Map();

  // Buckets without a household-written hint render as a bare name, exactly
  // as before (no prompt-size regression for the common case) — only a
  // bucket with aiInstructions set gets the "— hint: ..." suffix.
  const bucketLines = bucketHintLines(buckets);
  const merchantLines = merchants.map((m) => `${m.merchant} — ${formatCents(m.amountCents)}`);
  const prompt =
    `You are categorizing household bank transactions into budget buckets.\n` +
    `Available buckets (some carry a household-written hint after "— hint:"):\n${bucketLines.map((l) => `- ${l}`).join("\n")}\n\n` +
    `For each "merchant — amount" line below, pick the single best-fitting ` +
    `bucket name from the list above, or null if none of them fit. Give a ` +
    `confidence from 0 to 1 for how sure you are. Use the amount as a signal, ` +
    `not just the name — e.g. a small recurring charge (roughly $5-30) can be ` +
    `a real digital subscription, but a large recurring payment (hundreds or ` +
    `thousands of dollars) is far more likely a mortgage, rent, loan, or ` +
    `credit card payment than a "subscription", even if it repeats monthly. ` +
    `Return the "merchant" field exactly as given, without the amount.\n\n` +
    `Transactions:\n${merchantLines.join("\n")}`;

  // Top-level object (not a bare array) — required for Anthropic's forced
  // tool-use input_schema and OpenAI/Grok's strict JSON schema mode.
  const schema = resultsSchema({
    type: "object",
    properties: {
      merchant: { type: "string" },
      bucketName: { type: "string", nullable: true },
      confidence: { type: "number" },
    },
    required: ["merchant", "bucketName", "confidence"],
    additionalProperties: false,
  });

  const parsed = await callJson<{ results: { merchant: string; bucketName: string | null; confidence: number }[] }>(
    householdId,
    config,
    prompt,
    schema,
  );
  if (!parsed) return new Map();

  return resolveBucketSuggestions(
    buckets,
    parsed.results.map((r) => ({ key: r.merchant, bucketName: r.bucketName, confidence: r.confidence })),
  );
}

export type ReceiptBucketEntry = {
  key: string;
  merchant: string;
  amountCents: number;
  currentBucketName: string;
  items: { description: string; qty: number | null; totalCents: number | null }[];
};

// The receipt-aware counterpart to suggestBucketsForMerchants: the merchant
// rule filed each of these under `currentBucketName` (a Sam's Club charge →
// Groceries), but a matched email receipt says what was actually bought, so
// the line items — not the merchant name — decide. Batched: one call for every
// candidate this sync. Returns null (not an empty map) when no AI provider is
// configured or the call failed, so the caller retries next sync instead of
// recording a decision it never made.
export async function suggestBucketsFromReceipts(
  householdId: string,
  entries: ReceiptBucketEntry[],
  buckets: { id: string; name: string; aiInstructions?: string | null }[],
): Promise<Map<string, BucketSuggestion> | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config || entries.length === 0 || buckets.length === 0) return null;

  const bucketLines = bucketHintLines(buckets);
  const entryLines = entries.map((e) => {
    const items = e.items
      .slice(0, 12)
      .map((i) => `${i.qty != null && i.qty !== 1 ? `${i.qty}× ` : ""}${i.description}${i.totalCents != null ? ` (${formatCents(i.totalCents)})` : ""}`)
      .join("; ");
    return `[${e.key}] ${e.merchant} — ${formatCents(e.amountCents)} — currently in "${e.currentBucketName}" — items: ${items}`;
  });
  const prompt =
    `You are reviewing household bank transactions that were filed into a budget bucket by a ` +
    `default rule for the merchant name. Each one now has an itemized email receipt. Decide ` +
    `which bucket the purchase truly belongs in, judged by what was actually bought.\n` +
    `Available buckets (some carry a household-written hint after "— hint:"):\n${bucketLines.map((l) => `- ${l}`).join("\n")}\n\n` +
    `Rules: answer with the bucket the items belong in. If the items are consistent with the ` +
    `current bucket, or the receipt is a mix where the current bucket still holds most of the ` +
    `dollars, answer the CURRENT bucket. Only name a different bucket when the items ` +
    `clearly and predominantly belong there (for example a warehouse-club charge whose only ` +
    `line is unleaded fuel belongs in a fuel/gas bucket, not groceries). Give a confidence ` +
    `from 0 to 1. Return the "key" exactly as given.\n\n` +
    `Transactions:\n${entryLines.join("\n")}`;

  const schema = resultsSchema({
    type: "object",
    properties: {
      key: { type: "string" },
      bucketName: { type: "string", nullable: true },
      confidence: { type: "number" },
    },
    required: ["key", "bucketName", "confidence"],
    additionalProperties: false,
  });

  const parsed = await callJson<{ results: { key: string; bucketName: string | null; confidence: number }[] }>(
    householdId,
    config,
    prompt,
    schema,
  );
  if (!parsed) return null;

  return resolveBucketSuggestions(buckets, parsed.results);
}

export type BillCategorySuggestion = { categoryName: string | null; confidence: number };

// The categoryId counterpart to suggestBucketsForMerchants above — exact
// same batched-per-merchant shape/prompt structure/post-processing, just
// picking a subcategory instead of a bucket. Kept as its own function
// (rather than merging bucket+category into one call) since a household's
// bucket list and category list are independent axes — a merchant can have
// high bucket confidence and low/no category fit, or vice versa — and
// keeping them separate lets categorizeUncategorizedTransactions
// (src/lib/simplefin-sync.ts) auto-apply/gate each independently. Distinct
// from suggestCategoryForMerchant below (single-merchant, on-demand, no
// confidence — that one backs TrackAsBillForm's "Suggest" button and stays
// as-is).
export async function suggestCategoriesForMerchants(
  householdId: string,
  merchants: { merchant: string; amountCents: number }[],
  categories: { id: string; name: string }[],
): Promise<Map<string, BillCategorySuggestion>> {
  const result = new Map<string, BillCategorySuggestion>();
  const config = await getHouseholdAiConfig(householdId);
  if (!config || merchants.length === 0 || categories.length === 0) return result;

  const merchantLines = merchants.map((m) => `${m.merchant} — ${formatCents(m.amountCents)}`);
  const prompt =
    `You are picking a subcategory for household bank transactions.\n` +
    `Available categories: ${JSON.stringify(categories.map((c) => c.name))}\n\n` +
    `For each "merchant — amount" line below, pick the single best-fitting ` +
    `category name from the list above, or null if none of them fit well. ` +
    `Give a confidence from 0 to 1 for how sure you are. Return the ` +
    `"merchant" field exactly as given, without the amount.\n\n` +
    `Transactions:\n${merchantLines.join("\n")}`;

  const schema = resultsSchema({
    type: "object",
    properties: {
      merchant: { type: "string" },
      categoryName: { type: "string", nullable: true },
      confidence: { type: "number" },
    },
    required: ["merchant", "categoryName", "confidence"],
    additionalProperties: false,
  });

  const parsed = await callJson<{ results: { merchant: string; categoryName: string | null; confidence: number }[] }>(
    householdId,
    config,
    prompt,
    schema,
  );
  if (!parsed) return result;

  const categoryNamed = nameLookup(categories.map((c) => c.name));
  for (const entry of parsed.results) {
    result.set(entry.merchant, {
      categoryName: categoryNamed(entry.categoryName),
      confidence: clampConfidence(entry.confidence),
    });
  }

  return result;
}

// What a keyword-learning check is asking about — see checkForNewKeywords
// (src/lib/keyword-learning.ts) for the caller. `kind` mirrors
// LearnedKeyword.kind (schema.prisma) — a plain string, not a shared enum
// import, so a new kind never needs a schema change to add here.
export type KeywordCheckContext = {
  kind: string;
  subjectDescription: string; // e.g. "Buy Now Pay Later (BNPL) installment lenders"
  examples: string; // e.g. "Affirm, Klarna, Afterpay, Sezzle, PayPal Credit, Uplift, Splitit"
  distinguishFrom: string; // e.g. "a retailer that merely offers BNPL at checkout, or an ordinary recurring biller"
};

// Batched, once-ever-per-merchant-per-kind check (see checkForNewKeywords,
// src/lib/keyword-learning.ts, which caches every result — a merchant is
// never asked about the same kind twice) for whether an unrecognized
// recurring merchant belongs to some hardcoded, slow-moving brand list
// (BNPL lenders, subscription services, ...) — same "does this look like X"
// batched shape as suggestCategoriesForMerchants above, just a yes/no
// instead of a category pick. Deliberately relies on the model's own
// training knowledge rather than a dedicated web-search integration — a live
// search would add real infra (API key, cost, latency, a new failure mode)
// mainly to catch something newer than any model's training data, a rare
// event for a slow-moving list like "which companies are BNPL lenders" or
// "which services are well-known subscriptions."
export async function suggestKeywordMatches(
  householdId: string,
  merchants: string[],
  context: KeywordCheckContext,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const config = await getHouseholdAiConfig(householdId);
  if (!config || merchants.length === 0) return result;

  const prompt =
    `You are identifying ${context.subjectDescription} — companies like ` +
    `${context.examples} — from bank transaction merchant names.\n\n` +
    `For each merchant name below, say whether it is very likely to be one of ` +
    `these itself (not ${context.distinguishFrom}). Return the "merchant" ` +
    `field exactly as given.\n\n` +
    `Merchants:\n${merchants.map((m) => `- ${m}`).join("\n")}`;

  const schema = resultsSchema({
    type: "object",
    properties: {
      merchant: { type: "string" },
      isMatch: { type: "boolean" },
    },
    required: ["merchant", "isMatch"],
    additionalProperties: false,
  });

  const parsed = await callJson<{ results: { merchant: string; isMatch: boolean }[] }>(
    householdId,
    config,
    prompt,
    schema,
  );
  if (!parsed) return result;

  for (const entry of parsed.results) {
    result.set(entry.merchant, Boolean(entry.isMatch));
  }
  return result;
}

export type P2PClassification = { bucketName: string | null; categoryName: string | null; confidence: number };

// P2P (Venmo/Zelle/etc.) transactions all share the same generic merchant
// text — "who is this" carries zero signal there, unlike an ordinary
// merchant — so this works per-*transaction*, disambiguated by amount/
// timing/label instead, and always suggest-only (see the caller in
// categorizeUncategorizedTransactions, src/lib/simplefin-sync.ts — nothing
// from this function's confidence ever auto-commits bucketId/categoryId,
// only aiSuggestedBucketId/aiSuggestedCategoryId, regardless of how high it
// is: "it could be anything," per the household's own framing). `history` is
// the household's own recent CONFIRMED P2P classifications (real bucketId/
// categoryId set, not aiSuggested* — real precedent, not a guess) — this is
// the literal "learns through our own history" mechanism: not a
// MerchantRule (a rule keyed on "venmo" would be meaningless across
// unrelated payments), just labeled examples in the prompt for the model to
// pattern-match new transactions against by amount/timing/label similarity.
export async function suggestP2PClassifications(
  householdId: string,
  transactions: { id: string; party?: string | null; receiptNote?: string | null; amountCents: number; occurredOn: Date; label: string | null; notes: string | null }[],
  buckets: { id: string; name: string }[],
  categories: { id: string; name: string }[],
  history: {
    amountCents: number;
    occurredOn: Date;
    label: string | null;
    notes: string | null;
    receiptNote?: string | null;
    bucketName: string | null;
    categoryName: string | null;
  }[],
): Promise<Map<string, P2PClassification>> {
  const result = new Map<string, P2PClassification>();
  const config = await getHouseholdAiConfig(householdId);
  if (!config || transactions.length === 0 || (buckets.length === 0 && categories.length === 0)) return result;

  const describe = (t: { party?: string | null; receiptNote?: string | null; amountCents: number; occurredOn: Date; label: string | null; notes: string | null }) => {
    const parts = [formatCents(t.amountCents), t.occurredOn.toISOString().slice(0, 10)];
    // Present only when a matched receipt email named the counterparty (a
    // friend/family member for a person-to-person payment) — a hint for
    // THIS payment, not a rule.
    if (t.party) parts.push(`paid "${t.party}"`);
    // The memo the sender wrote on the payment, off the matched receipt —
    // usually the single most telling signal for what a P2P payment was for.
    if (t.receiptNote) parts.push(`memo "${t.receiptNote}"`);
    if (t.label) parts.push(`label "${t.label}"`);
    if (t.notes) parts.push(`notes "${t.notes}"`);
    return parts.join(", ");
  };

  const historyLines = history.map(
    (h) => `${describe(h)} -> bucket: ${h.bucketName ?? "none"}, category: ${h.categoryName ?? "none"}`,
  );
  const txnLines = transactions.map((t) => `id:${t.id} — ${describe(t)}`);

  const prompt =
    `You are matching household P2P app payments (Venmo/Zelle/CashApp) to a ` +
    `budget bucket and subcategory. The payment app's own merchant name ` +
    `carries no useful information — every payment looks the same ("Venmo") ` +
    `regardless of who it's actually for — so match by amount, date, who was ` +
    `paid (when known — shown as paid "Name"), the payment memo (shown as ` +
    `memo "..." — often the clearest clue), and any label/notes text, ` +
    `using the household's own past classifications below as precedent. A ` +
    `payment to a person can be for anything, so weigh the memo/amount, not ` +
    `just the name.\n\n` +
    `Available buckets: ${JSON.stringify(buckets.map((b) => b.name))}\n` +
    `Available categories: ${JSON.stringify(categories.map((c) => c.name))}\n\n` +
    (historyLines.length > 0
      ? `Past confirmed examples from this household:\n${historyLines.map((l) => `- ${l}`).join("\n")}\n\n`
      : `No past confirmed examples yet for this household.\n\n`) +
    `For each new payment below, suggest a bucket name and category name (or ` +
    `null for either if nothing fits well — a genuinely new/unrecognizable ` +
    `payment should get low confidence and/or null values rather than a ` +
    `forced guess), plus a confidence from 0 to 1. Return the "id" field ` +
    `exactly as given.\n\n` +
    `New payments:\n${txnLines.join("\n")}`;

  const schema = resultsSchema({
    type: "object",
    properties: {
      id: { type: "string" },
      bucketName: { type: "string", nullable: true },
      categoryName: { type: "string", nullable: true },
      confidence: { type: "number" },
    },
    required: ["id", "bucketName", "categoryName", "confidence"],
    additionalProperties: false,
  });

  const parsed = await callJson<{
    results: { id: string; bucketName: string | null; categoryName: string | null; confidence: number }[];
  }>(householdId, config, prompt, schema);
  if (!parsed) return result;

  const bucketNamed = nameLookup(buckets.map((b) => b.name));
  const categoryNamed = nameLookup(categories.map((c) => c.name));
  for (const entry of parsed.results) {
    result.set(entry.id, {
      bucketName: bucketNamed(entry.bucketName),
      categoryName: categoryNamed(entry.categoryName),
      confidence: clampConfidence(entry.confidence),
    });
  }

  return result;
}

export type CategorySuggestion = { categoryId: string | null; newCategoryName: string | null };

// On-demand (not batched at sync time like suggestBucketsForMerchants
// above) — triggered by the household clicking "Suggest" on TrackAsBillForm
// for one specific bill, not run automatically on every form open, so it
// only spends a household's AI quota when actually asked for. Matching
// against the household's real category list happens here, not just
// trusted from the model's own judgment — a model that thinks it picked an
// existing category but got the wording slightly wrong (plural, punctuation)
// should still resolve to that category rather than spawning a near-
// duplicate, and one that invents a name colliding with an existing
// category (case-insensitive) should resolve there too.
export async function suggestCategoryForMerchant(
  householdId: string,
  merchant: string,
  categories: { id: string; name: string }[],
): Promise<CategorySuggestion | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const categoryNames = categories.map((c) => c.name);
  const prompt =
    `You are picking a category for a household's recurring bill, subscription, or loan/card payment.\n` +
    `Existing categories: ${JSON.stringify(categoryNames)}\n\n` +
    `The bill/payment is from: "${merchant}"\n\n` +
    `If one of the existing categories is a good fit, return its name exactly ` +
    `as given above. If none of them fit well, invent a short new category ` +
    `name instead (2-3 words, Title Case, e.g. "Streaming", "Home Security").`;

  const schema = {
    type: "object",
    properties: {
      categoryName: { type: "string" },
    },
    required: ["categoryName"],
    additionalProperties: false,
  };

  const parsed = await callJson<{ categoryName: string }>(householdId, config, prompt, schema);
  const suggested = parsed?.categoryName?.trim();
  if (!suggested) return null;

  const matched = categories.find((c) => c.name.toLowerCase() === suggested.toLowerCase());
  return matched ? { categoryId: matched.id, newCategoryName: null } : { categoryId: null, newCategoryName: suggested };
}

// --- Plain-language amount-routing rule authoring ---
// The household types something like "gas station purchases under $15 should
// go to a convenience bucket, not Fuel"; this turns it into a concrete
// proposal the UI shows for confirmation before anything is written. The
// merchant snapshot below is the *only* set of merchant strings the model
// may return — it picks the ones the description refers to (e.g. every gas
// station in the list for "gas stations"), never invents new ones (the
// downstream MerchantRule is exact-match; see its schema comment).

export type RoutingContextMerchant = {
  merchant: string;
  txnCount: number;
  // Over the window the caller sampled (see buildRoutingRuleContext).
  minCents: number;
  maxCents: number;
  currentBucket: string | null;
};

export type RoutingRuleContext = {
  text: string;
  // The bucket whose settings the composer was opened from — the likely
  // "from" side of a split ("...not Fuel"), and the default place to look
  // for the transactions a backfill would move.
  fromBucketName: string;
  buckets: { name: string; monthlyCapCents: number }[];
  merchants: RoutingContextMerchant[];
  incomeCents: number;
  totalCapsCents: number;
  unallocatedCents: number;
};

export type RoutingRuleAdjustment = { bucketName: string; newCapCents: number };

export type RoutingRuleParse = {
  understood: boolean;
  restatement: string;
  maxCents: number;
  merchants: string[];
  targetKind: "existing" | "new" | "unknown";
  existingBucketName: string | null;
  newBucketName: string | null;
  newBucketCapCents: number | null;
  newBucketRationale: string | null;
  adjustments: RoutingRuleAdjustment[];
  note: string | null;
};

const ROUTING_RULE_SCHEMA = {
  type: "object",
  properties: {
    understood: { type: "boolean" },
    restatement: { type: "string" },
    maxDollars: { type: "number" },
    merchants: { type: "array", items: { type: "string" } },
    targetKind: { type: "string" }, // "existing" | "new" | "unknown" — normalized by the caller
    existingBucketName: { type: "string", nullable: true },
    newBucketName: { type: "string", nullable: true },
    newBucketCapDollars: { type: "number", nullable: true },
    newBucketRationale: { type: "string", nullable: true },
    adjustments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          bucketName: { type: "string" },
          newCapDollars: { type: "number" },
        },
        required: ["bucketName", "newCapDollars"],
        additionalProperties: false,
      },
    },
    note: { type: "string", nullable: true },
  },
  required: [
    "understood",
    "restatement",
    "maxDollars",
    "merchants",
    "targetKind",
    "existingBucketName",
    "newBucketName",
    "newBucketCapDollars",
    "newBucketRationale",
    "adjustments",
    "note",
  ],
  additionalProperties: false,
};

export async function parseRoutingRuleFromText(
  householdId: string,
  ctx: RoutingRuleContext,
): Promise<RoutingRuleParse | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const prompt =
    `A household wants to set up an "amount routing" rule for their budget app in plain words. ` +
    `Such a rule takes small purchases from a set of merchants and files them into a different ` +
    `budget bucket when the charge is at or below a dollar threshold (bigger charges from those ` +
    `same merchants are unaffected). Turn their sentence into a concrete proposal.\n\n` +
    `Their words: ${JSON.stringify(ctx.text)}\n` +
    `Opened from the "${ctx.fromBucketName}" bucket (the likely "from" side).\n\n` +
    `Their budget buckets (monthly caps, cents): ${JSON.stringify(ctx.buckets)}\n` +
    `Monthly income ${ctx.incomeCents}c; bucket caps total ${ctx.totalCapsCents}c; unallocated ${ctx.unallocatedCents}c.\n\n` +
    `Merchants seen recently — THE ONLY merchant strings you may return, copied exactly ` +
    `(count, min/max charge in cents, current bucket):\n${JSON.stringify(ctx.merchants)}\n\n` +
    `Do:\n` +
    `1. "maxDollars": the threshold from their sentence (a bare "under $15" means 15).\n` +
    `2. "merchants": every merchant from the list above their description refers to — for a ` +
    `category like "gas stations" that's each gas-station merchant present. Exact strings only, ` +
    `never invented ones. Empty if none apply.\n` +
    `3. Destination bucket. If an existing bucket clearly fits (named, or an obvious match like ` +
    `"convenience" -> a "Convenience"/"Snacks" bucket if they have one), set targetKind ` +
    `"existing" and existingBucketName. Otherwise targetKind "new": propose newBucketName ` +
    `(2-3 words, Title Case), newBucketCapDollars sized to the recent MONTHLY volume of the ` +
    `matching small purchases (estimate from their counts/amounts across the sample window), a ` +
    `one-sentence newBucketRationale, and "adjustments" — which existing bucket(s) to shrink to ` +
    `keep total caps within income, normally just the "from" bucket reduced by the new cap ` +
    `(that spend is leaving it). Give each adjustment's bucketName and its new full cap in ` +
    `newCapDollars. If there's enough unallocated income to cover the new cap, adjustments may ` +
    `be empty.\n` +
    `4. If you can't tell what they want, set understood false and explain in "note". Use "note" ` +
    `also for any caveat worth showing (e.g. you had to guess the destination).\n\n` +
    `"restatement": one plain sentence describing what will happen, for them to confirm.`;

  const parsed = await callJson<{
    understood: boolean;
    restatement: string;
    maxDollars: number;
    merchants: string[];
    targetKind: "existing" | "new" | "unknown";
    existingBucketName: string | null;
    newBucketName: string | null;
    newBucketCapDollars: number | null;
    newBucketRationale: string | null;
    adjustments: { bucketName: string; newCapDollars: number }[];
    note: string | null;
  }>(householdId, config, prompt, ROUTING_RULE_SCHEMA);
  if (!parsed) return null;

  return {
    understood: Boolean(parsed.understood),
    restatement: parsed.restatement?.trim() || "",
    maxCents: toCents(parsed.maxDollars) ?? 0,
    merchants: Array.isArray(parsed.merchants) ? parsed.merchants.map((m) => String(m).trim()).filter(Boolean) : [],
    targetKind: parsed.targetKind === "existing" || parsed.targetKind === "new" ? parsed.targetKind : "unknown",
    existingBucketName: parsed.existingBucketName?.trim() || null,
    newBucketName: parsed.newBucketName?.trim() || null,
    newBucketCapCents: toCents(parsed.newBucketCapDollars),
    newBucketRationale: parsed.newBucketRationale?.trim() || null,
    adjustments: Array.isArray(parsed.adjustments)
      ? parsed.adjustments
          .map((a) => ({ bucketName: String(a.bucketName ?? "").trim(), newCapCents: toCents(a.newCapDollars) }))
          .filter((a): a is RoutingRuleAdjustment => Boolean(a.bucketName) && a.newCapCents != null)
      : [],
    note: parsed.note?.trim() || null,
  };
}

// Picks a lucide icon key for each bucket name whose name matched none of
// the keyword rules in src/lib/bucket-icons.tsx. Batched into one call for
// every unresolved bucket, and only ever run when there's at least one (see
// ensureBucketIcons, src/lib/bucket-icons-sync.ts) — a household with only
// keyword-matched buckets never spends a call here. Constrained to the
// given key list; anything off-list (or a bucket the model skips) is
// dropped by the caller and falls back to the Wallet default.
export async function suggestBucketIcons(
  householdId: string,
  names: string[],
  allowedKeys: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const config = await getHouseholdAiConfig(householdId);
  if (!config || names.length === 0) return result;

  const prompt =
    `Pick the best-fitting icon for each household budget bucket name below.\n` +
    `Choose the icon "key" from exactly this list (return the key verbatim):\n` +
    `${JSON.stringify(allowedKeys)}\n\n` +
    `Bucket names:\n${names.map((n) => `- ${n}`).join("\n")}\n\n` +
    `Return the "name" field exactly as given. If none of the keys fit a ` +
    `name at all, use "wallet".`;

  const schema = resultsSchema({
    type: "object",
    properties: {
      name: { type: "string" },
      iconKey: { type: "string" },
    },
    required: ["name", "iconKey"],
    additionalProperties: false,
  });

  const parsed = await callJson<{ results: { name: string; iconKey: string }[] }>(
    householdId,
    config,
    prompt,
    schema,
  );
  if (!parsed) return result;

  const allowed = new Set(allowedKeys);
  const named = nameLookup(names);
  for (const entry of parsed.results) {
    const name = named(entry.name);
    const key = entry.iconKey?.trim();
    if (name && key && allowed.has(key)) result.set(name, key);
  }

  return result;
}

export type MonthSummary = {
  label: string;
  totalSpentCents: number;
  totalCapCents?: number;
  // Every dollar of income that actually landed this month (irregular deposits
  // included) — the breakeven verdict is measured against this.
  totalIncomeCents?: number;
  // Planned recurring income for a normal month (confirmed paychecks + opted-in
  // P2P, run through the household's incomeCalcMethod). Forward budgeting is
  // built on this, not on a month that happened to catch extra one-off money.
  recurringIncomeCents?: number;
  buckets: { name: string; capCents?: number; spentCents: number }[];
  // One-time purchases funded outside the monthly budget (a car down
  // payment) — NOT part of buckets/totalSpentCents/totalCapCents. See
  // MonthReport.oneTimePurchases.
  oneTimePurchases?: { name: string; capCents: number; spentCents: number }[];
  // One-off/P2P income breakdown — see MonthReport.extraIncome. Already
  // inside totalIncomeCents; never add it again.
  extraIncome?: { receivedCents: number; appliedCents: number; unappliedCents: number; byBucket: { name: string; amountCents: number }[] };
  // Real debt figures (see getHouseholdSavingsCapacity, src/lib/savings.ts)
  // — only ever set for the recurring Monthly Report, not the onboarding
  // Startup Report, since no debt is typically tracked yet at that point.
  // Grounds a debt-vs-savings budgetingIssues suggestion in real numbers
  // instead of just the household's stated goalPosture label.
  debt?: {
    totalBalanceCents: number;
    totalMinimumsCents: number;
    committedExtraCents: number;
    estimatedMonthlySaveableCents: number;
  };
  // Household's target monthly saveable amount (getHouseholdSavingsCapacity)
  // vs. what this specific month actually cleared (totalIncomeCents minus
  // actual bucket spend) — the "did we actually run a surplus" figure the
  // budgetCorrection/postureSuggestion findings below are built around.
  surplus?: { targetMonthlySaveableCents: number; actualSurplusCents: number };
  // Active SavingsGoal rows, nearest targetDate first — grounds
  // postureSuggestion (SAVINGS) and savingsGoalInsights in real goals
  // instead of an invented one.
  savingsGoals?: { name: string; targetAmountCents: number; currentAmountCents: number; targetDate: string | null }[];
  // The household's own debts, pre-sorted by computeAttackOrder
  // (src/lib/debt-payoff.ts) per its real payoffOrder setting
  // (AVALANCHE/SNOWBALL/CUSTOM) — index 0 is "attack this one first,"
  // already decided by the household's own configuration, not something
  // the model should re-derive or override.
  debtAttackOrder?: { name: string; balanceCents: number; aprBasisPoints: number; minPaymentCents: number }[];
  // CHECKING/SAVINGS accounts with a household-entered APY
  // (Account.apyBasisPoints) — for comparing "pay down debt" against "grow
  // savings" using real numbers only; never a lookup of what a bank
  // actually offers (no data source for that).
  savingsAccounts?: { name: string; balanceCents: number; apyBasisPoints: number | null }[];
  // Forward-looking inputs for the "Set the Month" budget allocation
  // (findings.budgetPlan) — only ever set for the recurring Monthly Report,
  // never the Startup Report. All amounts in cents. Assembled by
  // assembleBudgetPlanInputs (src/lib/budget-plan.ts). Every "locked"/forward
  // figure here is schedule-driven (expected bill/debt amount × cadence), NOT
  // gated on whether this month's payment has landed in bank sync yet.
  budgetInputs?: {
    targetMonthLabel: string; // e.g. "December"
    targetMonthNumber: number; // 1-12
    totalMonthlyIncomeCents: number;
    // poolCents >= Σ(current bucket caps) + lockedObligationsCents — i.e. the
    // household's existing budget already fits inside its income.
    atBreakeven: boolean;
    // Debt reserved OUTSIDE the buckets: minimums for debts not assigned to a
    // bucket + unassigned payoff-plan extra. Debt whose payment IS assigned to
    // a bucket lives in that bucket's debtFloorCents instead, not here.
    lockedObligationsCents: number; // debtMinimumsCents + payoffExtraMonthlyCents
    debtMinimumsCents: number;
    payoffExtraMonthlyCents: number; // 0 unless Household.payoffPlanEnabled
    adultsCount: number;
    kidsCount: number;
    // The household's amount-banded MerchantRules ("Walmart $60+ -> Groceries")
    // with each band's recent monthly spend — these beat a plain merchant
    // route, so a merchant-driven bucket idea has to pick a band to route.
    merchantAmountRules?: {
      merchant: string;
      minCents: number;
      maxCents: number;
      bucketName: string | null;
      avgMonthlyCents: number;
    }[];
    // Household-wide merchant frequency/spread digest (buildBucketAndMerchantDigest)
    // — the signal for proposing a merchant-driven bucket split.
    topMerchants?: {
      merchant: string;
      txnCount: number;
      sharePct: number;
      totalCents: number;
      minCents: number;
      maxCents: number;
      dominantBucket: string | null;
      bucketSpread: number;
      categorySpread: number;
      uncategorizedPct: number;
    }[];
    buckets: {
      name: string;
      trackingMode: "SPEND" | "RECURRING" | "MIXED";
      currentCapCents: number;
      lastMonthActualCents: number;
      threeMonthAvgCents: number;
      twelveMonthAvgCents: number;
      leanestRecentCents: number;
      sameMonthLastYearCents: number | null;
      twelveMonthSeries: number[]; // oldest -> newest, one net-spend figure per month
      projectedRecurringCents: number | null; // RECURRING/MIXED only
      // Bucket-assigned debt payments (mortgage, auto loans) this bucket's cap
      // must cover — a hard floor: suggestedCap >= debtFloorCents (+ projected).
      debtFloorCents: number;
      // What actually landed in this bucket over the trailing ~4 months.
      // Per merchant: totalCents/txnCount span the whole ~4-month window;
      // lastMonthCents/lastMonthTxnCount are just the previous calendar month;
      // avgMonthlyCents is the window total / 4. Weight last month and the
      // monthly average, not the raw 4-month totals.
      composition?: {
        totalCents: number;
        txnCount: number;
        topMerchants: {
          merchant: string;
          txnCount: number;
          totalCents: number;
          lastMonthCents: number;
          lastMonthTxnCount: number;
          avgMonthlyCents: number;
        }[];
        topLabels: string[];
        topCategories: string[];
      };
    }[];
    savingsGoals: {
      name: string;
      targetAmountCents: number;
      currentAmountCents: number;
      targetDate: string | null;
      monthlyToHitTargetCents: number | null;
      monthsUntilTarget: number | null;
    }[];
    // How the last few CONFIRMED budget plans actually turned out, per bucket —
    // planned cap vs real spend. Lets the model bias a persistently-wrong
    // allocation up or down instead of re-proposing the same miss.
    priorPlanOutcomes: {
      periodKey: string;
      buckets: { name: string; plannedCents: number; actualCents: number; varianceCents: number }[];
    }[];
  };
};

// Shared by both the recurring Monthly Report and the one-time onboarding
// Startup Report (src/lib/reports.ts) — a single callJson call returns both
// the free-text narrative and structured findings together (same "structured
// fields + one prose field in one schema" shape as planGoalFromDescription's
// feedback field below), rather than two separate AI calls per report.
export type ReportFindings = {
  totalSpentCents: number;
  totalCapCents: number;
  totalIncomeCents: number;
  // The covered month's deterministic bucket breakdown, FROZEN into the
  // report when it's created (and while its data is still settling — see
  // refreshReportFindings, which only re-snapshots while the household's
  // budget is unchanged). /reports renders from this, not a live re-query:
  // a past month's report must show that month's buckets and caps, not
  // whatever the household has set now (household report, 2026-09-03: an
  // August report showing September's caps and a bucket that didn't exist
  // in August). Null on reports generated before this field existed —
  // report-view.tsx falls back to the top-level totals + overspendingBuckets.
  monthSnapshot: {
    totalSpentCents: number;
    totalCapCents: number;
    totalIncomeCents: number;
    recurringIncomeCents: number;
    buckets: { name: string; capCents: number; spentCents: number }[];
    // Listed, never totaled — see MonthReport.oneTimePurchases. Optional:
    // absent on snapshots frozen before 2026-10-02.
    oneTimePurchases?: { name: string; capCents: number; spentCents: number }[];
    // See MonthReport.extraIncome. Optional: absent on snapshots frozen
    // before 2026-10-07 (/reports falls back to the live figure).
    extraIncome?: { receivedCents: number; appliedCents: number; unappliedCents: number; byBucket: { name: string; amountCents: number }[] };
  } | null;
  overspendingBuckets: { name: string; overspendCents: number }[];
  newBucketSuggestions: {
    name: string;
    monthlyCapCents: number;
    trackingMode: "SPEND" | "RECURRING" | "MIXED";
    rationale: string;
  }[];
  detectedRecurring: { merchant: string; amountCents: number; cadence: string }[];
  budgetingIssues: string[];
  // Set only when the month ran a deficit (surplus.actualSurplusCents < 0)
  // — minimal cuts that sum to at least closing the gap, preferring
  // discretionary/overspent buckets over essential/recurring-bill ones.
  // Null in a breakeven-or-better month; never proposes trimming further
  // than needed to close the gap.
  budgetCorrection: {
    deficitCents: number;
    suggestedCuts: { bucketName: string; suggestedCapCents: number; cutCents: number; rationale: string }[];
  } | null;
  // Only populated once breakeven — where the household's own goalPosture
  // says the leftover margin should go. Null for BALANCED households with
  // nothing manually committed yet, or when there's no real margin to
  // suggest allocating.
  postureSuggestion: {
    type: "DEBT_PAYDOWN" | "SAVINGS";
    targetName: string;
    suggestedAmountCents: number;
    rationale: string;
  } | null;
  // "Your stated Primary Goal doesn't match your actual finances" — distinct
  // from postureSuggestion ("do more toward the goal you already have"). Only
  // at breakeven-or-better. e.g. SAVINGS_FOCUSED while carrying a 24%-APR card
  // -> suggest DEBT_PAYDOWN; DEBT_PAYDOWN with only a low-rate mortgage left
  // -> suggest SAVINGS_FOCUSED. Rendered with a one-tap "Switch" in the report.
  postureRealignment: {
    currentPosture: "DEBT_PAYDOWN" | "SAVINGS_FOCUSED" | "BALANCED";
    suggestedPosture: "DEBT_PAYDOWN" | "SAVINGS_FOCUSED" | "BALANCED";
    rationale: string;
  } | null;
  // Only when surplus materially exceeds anything already committed —
  // compares the top debtAttackOrder entry's APR against the top
  // savingsAccounts entry's APY, using only real household-confirmed
  // numbers (never an invented product/rate). Null otherwise.
  bigSurplusOpportunity: {
    surplusCents: number;
    debtOption: { name: string; aprBasisPoints: number } | null;
    savingsOption: { name: string; apyBasisPoints: number } | null;
    note: string;
  } | null;
  // Progress/on-track status for each active SavingsGoal — evaluative
  // (how's it going), distinct from postureSuggestion's prescriptive "do
  // this next."
  savingsGoalInsights: { name: string; onTrack: boolean; note: string }[];
  // The forward-looking allocation proposal for the NEW month — only set when
  // current.budgetInputs was provided (the recurring Monthly Report), null for
  // the Startup Report. Merged with fresh deterministic numbers and surfaced
  // as the "Set the Month" control — see src/lib/budget-plan.ts.
  budgetPlan: {
    overallExplanation: string;
    atBreakeven: boolean;
    // One entry per existing bucket (match current.budgetInputs.buckets by
    // name). suggestedCapCents is this month's proposed cap.
    buckets: { name: string; suggestedCapCents: number; rationale: string }[];
    // Same rules as newBucketSuggestions above, plus 2-5 starter category names.
    // sourceMerchant is set only for a "give merchant X its own bucket" split —
    // the allocator then offers a one-tap route + backfill on confirm.
    newBuckets: {
      name: string;
      trackingMode: "SPEND" | "RECURRING" | "MIXED";
      monthlyCapCents: number;
      rationale: string;
      suggestedCategories: string[];
      sourceMerchant: string | null;
      // Route only this merchant's purchases within [min, max] (a bounded
      // MerchantRule) instead of all of them. Both null = every purchase.
      routeAmountMinCents: number | null;
      routeAmountMaxCents: number | null;
    }[];
    // The Surplus slider's proposed value: ~0 when not at breakeven ("just get
    // to break even first"), a real positive figure once there.
    recommendedSurplusCents: number;
    // Plain-language "here's where your surplus goes and what it does" — the
    // direction itself follows Household.goalPosture and is computed by the app
    // (resolveSurplusDirection), NOT chosen by the model. 2-3 sentences,
    // grounded in real debt/savings numbers. Shown in the allocator's
    // read-only "Where Your Surplus Goes" card.
    surplusExplanation: string;
    savingsAllocations: { goalName: string; monthlyCents: number; rationale: string }[];
    // Known seasonal spikes for the target month (or a SavingsGoal targetDate
    // ≤ 2 months out). Display + a one-click "Start a Sinking Fund" CTA only —
    // never auto-added to the partition.
    seasonalAlerts: {
      title: string;
      bucketName: string | null;
      expectedExtraCents: number;
      note: string;
      suggestSinkingFund: boolean;
      sinkingFundName: string | null;
      sinkingFundMonthlyCents: number | null;
      sinkingFundTargetMonth: string | null; // "YYYY-MM"
    }[];
  } | null;
};

export type ReportContent = { narrative: string; findings: ReportFindings };

export type ReportTrendEntry = {
  periodKey: string;
  totalSpentCents: number;
  totalCapCents: number;
  topOverspendBuckets: { name: string; overspendCents: number }[];
};

export type HouseholdProfileInput = { goalPosture: string; adultsCount: number; kidsCount: number };

const GOAL_POSTURE_PHRASE: Record<string, string> = {
  DEBT_PAYDOWN: "paying down debt as fast as possible",
  SAVINGS_FOCUSED: "building up savings",
  BALANCED: "a balance of paying down debt and building savings",
};

const REPORT_CONTENT_SCHEMA = {
  type: "object",
  properties: {
    narrative: { type: "string" },
    totalSpentDollars: { type: "number" },
    totalCapDollars: { type: "number" },
    totalIncomeDollars: { type: "number" },
    overspendingBuckets: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, overspendDollars: { type: "number" } },
        required: ["name", "overspendDollars"],
        additionalProperties: false,
      },
    },
    newBucketSuggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          monthlyCapDollars: { type: "number" },
          trackingMode: { type: "string", enum: ["SPEND", "RECURRING", "MIXED"] },
          rationale: { type: "string" },
        },
        required: ["name", "monthlyCapDollars", "trackingMode", "rationale"],
        additionalProperties: false,
      },
    },
    detectedRecurring: {
      type: "array",
      items: {
        type: "object",
        properties: {
          merchant: { type: "string" },
          amountDollars: { type: "number" },
          cadence: { type: "string" },
        },
        required: ["merchant", "amountDollars", "cadence"],
        additionalProperties: false,
      },
    },
    budgetingIssues: { type: "array", items: { type: "string" } },
    budgetCorrection: {
      type: "object",
      nullable: true,
      properties: {
        deficitDollars: { type: "number" },
        suggestedCuts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bucketName: { type: "string" },
              suggestedCapDollars: { type: "number" },
              cutDollars: { type: "number" },
              rationale: { type: "string" },
            },
            required: ["bucketName", "suggestedCapDollars", "cutDollars", "rationale"],
            additionalProperties: false,
          },
        },
      },
      required: ["deficitDollars", "suggestedCuts"],
      additionalProperties: false,
    },
    postureSuggestion: {
      type: "object",
      nullable: true,
      properties: {
        type: { type: "string", enum: ["DEBT_PAYDOWN", "SAVINGS"] },
        targetName: { type: "string" },
        suggestedAmountDollars: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["type", "targetName", "suggestedAmountDollars", "rationale"],
      additionalProperties: false,
    },
    postureRealignment: {
      type: "object",
      nullable: true,
      properties: {
        currentPosture: { type: "string", enum: ["DEBT_PAYDOWN", "SAVINGS_FOCUSED", "BALANCED"] },
        suggestedPosture: { type: "string", enum: ["DEBT_PAYDOWN", "SAVINGS_FOCUSED", "BALANCED"] },
        rationale: { type: "string" },
      },
      required: ["currentPosture", "suggestedPosture", "rationale"],
      additionalProperties: false,
    },
    bigSurplusOpportunity: {
      type: "object",
      nullable: true,
      properties: {
        surplusDollars: { type: "number" },
        debtOption: {
          type: "object",
          nullable: true,
          properties: { name: { type: "string" }, aprBasisPoints: { type: "number" } },
          required: ["name", "aprBasisPoints"],
          additionalProperties: false,
        },
        savingsOption: {
          type: "object",
          nullable: true,
          properties: { name: { type: "string" }, apyBasisPoints: { type: "number" } },
          required: ["name", "apyBasisPoints"],
          additionalProperties: false,
        },
        note: { type: "string" },
      },
      required: ["surplusDollars", "debtOption", "savingsOption", "note"],
      additionalProperties: false,
    },
    savingsGoalInsights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          onTrack: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["name", "onTrack", "note"],
        additionalProperties: false,
      },
    },
    budgetPlan: {
      type: "object",
      nullable: true,
      properties: {
        overallExplanation: { type: "string" },
        atBreakeven: { type: "boolean" },
        buckets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              suggestedCapDollars: { type: "number" },
              rationale: { type: "string" },
            },
            required: ["name", "suggestedCapDollars", "rationale"],
            additionalProperties: false,
          },
        },
        newBuckets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              trackingMode: { type: "string", enum: ["SPEND", "RECURRING", "MIXED"] },
              monthlyCapDollars: { type: "number" },
              rationale: { type: "string" },
              suggestedCategories: { type: "array", items: { type: "string" } },
              sourceMerchant: { type: "string", nullable: true },
              routeAmountMinDollars: { type: "number", nullable: true },
              routeAmountMaxDollars: { type: "number", nullable: true },
            },
            required: [
              "name",
              "trackingMode",
              "monthlyCapDollars",
              "rationale",
              "suggestedCategories",
              "sourceMerchant",
              "routeAmountMinDollars",
              "routeAmountMaxDollars",
            ],
            additionalProperties: false,
          },
        },
        recommendedSurplusDollars: { type: "number" },
        surplusExplanation: { type: "string" },
        savingsAllocations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              goalName: { type: "string" },
              monthlyDollars: { type: "number" },
              rationale: { type: "string" },
            },
            required: ["goalName", "monthlyDollars", "rationale"],
            additionalProperties: false,
          },
        },
        seasonalAlerts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bucketName: { type: "string", nullable: true },
              expectedExtraDollars: { type: "number" },
              note: { type: "string" },
              suggestSinkingFund: { type: "boolean" },
              sinkingFundName: { type: "string", nullable: true },
              sinkingFundMonthlyDollars: { type: "number", nullable: true },
              sinkingFundTargetMonth: { type: "string", nullable: true },
            },
            required: [
              "title",
              "bucketName",
              "expectedExtraDollars",
              "note",
              "suggestSinkingFund",
              "sinkingFundName",
              "sinkingFundMonthlyDollars",
              "sinkingFundTargetMonth",
            ],
            additionalProperties: false,
          },
        },
      },
      required: [
        "overallExplanation",
        "atBreakeven",
        "buckets",
        "newBuckets",
        "recommendedSurplusDollars",
        "surplusExplanation",
        "savingsAllocations",
        "seasonalAlerts",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "narrative",
    "totalSpentDollars",
    "totalCapDollars",
    "totalIncomeDollars",
    "overspendingBuckets",
    "newBucketSuggestions",
    "detectedRecurring",
    "budgetingIssues",
    "budgetCorrection",
    "postureSuggestion",
    "postureRealignment",
    "bigSurplusOpportunity",
    "savingsGoalInsights",
    "budgetPlan",
  ],
  additionalProperties: false,
};

type RawReportContent = {
  narrative: string;
  totalSpentDollars: number;
  totalCapDollars: number;
  totalIncomeDollars: number;
  overspendingBuckets: { name: string; overspendDollars: number }[];
  newBucketSuggestions: {
    name: string;
    monthlyCapDollars: number;
    trackingMode: "SPEND" | "RECURRING" | "MIXED";
    rationale: string;
  }[];
  detectedRecurring: { merchant: string; amountDollars: number; cadence: string }[];
  budgetingIssues: string[];
  budgetCorrection: {
    deficitDollars: number;
    suggestedCuts: { bucketName: string; suggestedCapDollars: number; cutDollars: number; rationale: string }[];
  } | null;
  postureSuggestion: {
    type: "DEBT_PAYDOWN" | "SAVINGS";
    targetName: string;
    suggestedAmountDollars: number;
    rationale: string;
  } | null;
  postureRealignment: {
    currentPosture: "DEBT_PAYDOWN" | "SAVINGS_FOCUSED" | "BALANCED";
    suggestedPosture: "DEBT_PAYDOWN" | "SAVINGS_FOCUSED" | "BALANCED";
    rationale: string;
  } | null;
  bigSurplusOpportunity: {
    surplusDollars: number;
    debtOption: { name: string; aprBasisPoints: number } | null;
    savingsOption: { name: string; apyBasisPoints: number } | null;
    note: string;
  } | null;
  savingsGoalInsights: { name: string; onTrack: boolean; note: string }[];
  budgetPlan: {
    overallExplanation: string;
    atBreakeven: boolean;
    buckets: { name: string; suggestedCapDollars: number; rationale: string }[];
    newBuckets: {
      name: string;
      trackingMode: "SPEND" | "RECURRING" | "MIXED";
      monthlyCapDollars: number;
      rationale: string;
      suggestedCategories: string[];
      sourceMerchant: string | null;
      routeAmountMinDollars: number | null;
      routeAmountMaxDollars: number | null;
    }[];
    recommendedSurplusDollars: number;
    surplusExplanation: string;
    savingsAllocations: { goalName: string; monthlyDollars: number; rationale: string }[];
    seasonalAlerts: {
      title: string;
      bucketName: string | null;
      expectedExtraDollars: number;
      note: string;
      suggestSinkingFund: boolean;
      sinkingFundName: string | null;
      sinkingFundMonthlyDollars: number | null;
      sinkingFundTargetMonth: string | null;
    }[];
  } | null;
};

// A route band is only meaningful as a sane [min, max] pair — one bound
// missing means "no lower/upper limit" (0 / open-ended), both missing means
// route every purchase. A min above max is discarded rather than guessed at.
const OPEN_ROUTE_MAX_CENTS = 2_000_000_000;
function parseRouteBand(
  minDollars: number | null | undefined,
  maxDollars: number | null | undefined,
): { routeAmountMinCents: number | null; routeAmountMaxCents: number | null } {
  if (minDollars == null && maxDollars == null) return { routeAmountMinCents: null, routeAmountMaxCents: null };
  const min = minDollars == null ? 0 : Math.max(0, dollarsToCents(minDollars));
  const max = maxDollars == null ? OPEN_ROUTE_MAX_CENTS : dollarsToCents(maxDollars);
  if (max < min) return { routeAmountMinCents: null, routeAmountMaxCents: null };
  // Only the two shapes amount-routing rules support anywhere else in the app
  // — "up to $X" (min 0) or "$X and up" (open max). Bucket Settings and its
  // threshold editor read every bounded rule as one of those two, so a closed
  // "$20–$60" window would render as "over $20" and break on edit
  // (2026-10-03 code review). Anything else is dropped, never written.
  if (min > 0 && max < OPEN_ROUTE_MAX_CENTS) return { routeAmountMinCents: null, routeAmountMaxCents: null };
  return { routeAmountMinCents: min, routeAmountMaxCents: max };
}

function parseBudgetPlan(bp: RawReportContent["budgetPlan"]): ReportFindings["budgetPlan"] {
  if (!bp) return null;
  return {
    overallExplanation: bp.overallExplanation,
    atBreakeven: bp.atBreakeven,
    buckets: bp.buckets.map((b) => ({
      name: b.name,
      suggestedCapCents: dollarsToCents(b.suggestedCapDollars),
      rationale: b.rationale,
    })),
    newBuckets: bp.newBuckets.map((b) => ({
      name: b.name,
      trackingMode: b.trackingMode,
      monthlyCapCents: dollarsToCents(b.monthlyCapDollars),
      rationale: b.rationale,
      suggestedCategories: b.suggestedCategories,
      sourceMerchant: b.sourceMerchant?.trim() || null,
      ...parseRouteBand(b.routeAmountMinDollars, b.routeAmountMaxDollars),
    })),
    recommendedSurplusCents: dollarsToCents(bp.recommendedSurplusDollars),
    surplusExplanation: bp.surplusExplanation,
    savingsAllocations: bp.savingsAllocations.map((s) => ({
      goalName: s.goalName,
      monthlyCents: dollarsToCents(s.monthlyDollars),
      rationale: s.rationale,
    })),
    seasonalAlerts: bp.seasonalAlerts.map((a) => ({
      title: a.title,
      bucketName: a.bucketName,
      expectedExtraCents: dollarsToCents(a.expectedExtraDollars),
      note: a.note,
      suggestSinkingFund: a.suggestSinkingFund,
      sinkingFundName: a.sinkingFundName,
      sinkingFundMonthlyCents:
        a.sinkingFundMonthlyDollars == null ? null : dollarsToCents(a.sinkingFundMonthlyDollars),
      sinkingFundTargetMonth: a.sinkingFundTargetMonth,
    })),
  };
}

function parseReportContent(parsed: RawReportContent | null): ReportContent | null {
  if (!parsed) return null;
  return {
    narrative: parsed.narrative,
    findings: {
      totalSpentCents: dollarsToCents(parsed.totalSpentDollars),
      totalCapCents: dollarsToCents(parsed.totalCapDollars),
      totalIncomeCents: dollarsToCents(parsed.totalIncomeDollars),
      // Deterministic — filled in by reports.ts right after this returns, from
      // the same MonthReport this content describes.
      monthSnapshot: null,
      overspendingBuckets: parsed.overspendingBuckets.map((b) => ({
        name: b.name,
        overspendCents: dollarsToCents(b.overspendDollars),
      })),
      newBucketSuggestions: parsed.newBucketSuggestions.map((b) => ({
        name: b.name,
        monthlyCapCents: dollarsToCents(b.monthlyCapDollars),
        trackingMode: b.trackingMode,
        rationale: b.rationale,
      })),
      detectedRecurring: parsed.detectedRecurring.map((r) => ({
        merchant: r.merchant,
        amountCents: dollarsToCents(r.amountDollars),
        cadence: r.cadence,
      })),
      budgetingIssues: parsed.budgetingIssues,
      budgetCorrection: parsed.budgetCorrection
        ? {
            deficitCents: dollarsToCents(parsed.budgetCorrection.deficitDollars),
            suggestedCuts: parsed.budgetCorrection.suggestedCuts.map((c) => ({
              bucketName: c.bucketName,
              suggestedCapCents: dollarsToCents(c.suggestedCapDollars),
              cutCents: dollarsToCents(c.cutDollars),
              rationale: c.rationale,
            })),
          }
        : null,
      postureSuggestion: parsed.postureSuggestion
        ? {
            type: parsed.postureSuggestion.type,
            targetName: parsed.postureSuggestion.targetName,
            suggestedAmountCents: dollarsToCents(parsed.postureSuggestion.suggestedAmountDollars),
            rationale: parsed.postureSuggestion.rationale,
          }
        : null,
      postureRealignment: parsed.postureRealignment ?? null,
      bigSurplusOpportunity: parsed.bigSurplusOpportunity
        ? {
            surplusCents: dollarsToCents(parsed.bigSurplusOpportunity.surplusDollars),
            debtOption: parsed.bigSurplusOpportunity.debtOption,
            savingsOption: parsed.bigSurplusOpportunity.savingsOption,
            note: parsed.bigSurplusOpportunity.note,
          }
        : null,
      savingsGoalInsights: parsed.savingsGoalInsights,
      budgetPlan: parseBudgetPlan(parsed.budgetPlan),
    },
  };
}

// How long a single callJson attempt gets before generateMonthlyReportContent
// gives up and tries once more — this now runs unattended overnight (see
// refreshReportFindings, src/lib/reports.ts), not just on a live page load,
// and callJson itself has no timeout of its own (a bare fetch with no
// AbortSignal — confirmed, not something to imitate here). Not a true
// cancellation (callJson has no signal param to thread one through), just a
// bound on how long the caller waits before moving on.
//
// Bumped 15s -> 45s (2026-08-30): the default Gemini model moved to
// gemini-3.6-flash, a reasoning model, and a full REPORT_CONTENT_SCHEMA call
// (narrative + findings + the forward budgetPlan block) reliably runs
// ~15-30s+ — measured 14-15s even for a trimmed schema. At 15s BOTH attempts
// timed out, silently degrading every household's monthly report AND budget
// plan to the deterministic fallback with no lastError recorded (the timeout
// path here resolves null without callJson ever rejecting). See the parity
// audit in WORKING_ON.md.
const REPORT_AI_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

// The forward "budgetPlan" block's instructions — shared by the monthly
// report's single AI call and generateBudgetPlanRedraft below, so a redraft
// follows exactly the same sizing/partition rules as the original draft.
function budgetPlanGuidanceFor(bi: NonNullable<MonthSummary["budgetInputs"]>): string {
  return (
    `Also produce "budgetPlan" — the forward-looking allocation for the NEW month (${bi.targetMonthLabel}). ` +
      `The household's financial ladder, in order: (1) if overspending, get to break even — spend no more than income; ` +
      `(2) once at break even, deliberately run a positive monthly surplus; (3) put that surplus to work per goalPosture ` +
      `(DEBT_PAYDOWN -> extra onto debtAttackOrder[0]; SAVINGS_FOCUSED -> nearest-deadline goal; BALANCED -> split). ` +
      `Every rationale and overallExplanation must say where this month sits on that ladder.\n\n` +
      `budgetInputs (all cents) carries: totalMonthlyIncomeCents (the pool to partition), atBreakeven, ` +
      `lockedObligationsCents (debt minimums for debts NOT assigned to a bucket + unassigned payoff-plan extra — ` +
      `already reserved, NEVER allocate to these), and per bucket its currentCapCents, real spend history ` +
      `(lastMonthActualCents, threeMonthAvgCents, twelveMonthAvgCents, leanestRecentCents, sameMonthLastYearCents, ` +
      `twelveMonthSeries oldest->newest), projectedRecurringCents for RECURRING/MIXED buckets, and debtFloorCents — ` +
      `debt payments (a mortgage, an auto loan) the household assigned to THIS bucket. suggestedCap for a bucket MUST ` +
      `be >= debtFloorCents + (its projectedRecurringCents), and the history figures already include those debt ` +
      `payments so anchoring to them stays consistent.\n\n` +
      `Partition rule: Σ(budgetPlan.buckets suggestedCap) + recommendedSurplus + Σ(savingsAllocations monthly) + ` +
      `lockedObligationsCents should equal totalMonthlyIncomeCents (the app will normalize small drift into Surplus). ` +
      `Return one budgetPlan.buckets entry per bucket in budgetInputs.buckets, matched by name.\n\n` +
      `Household size: ${bi.adultsCount} adult(s), ${bi.kidsCount} kid(s). Weigh it ` +
      `when judging whether a category's spend is reasonable — a $500/mo groceries cap means very different things for ` +
      `1 adult vs. 2 adults + 4 kids.\n\n` +
      `What's in each bucket: every bucket carries "composition" — its trailing ~4-month spend broken down by ` +
      `topMerchants, topLabels (the household's own tags), topCategories, plus totalCents/txnCount. Each ` +
      `topMerchants entry has totalCents/txnCount (the whole ~4-month window), lastMonthCents/lastMonthTxnCount ` +
      `(previous calendar month only), and avgMonthlyCents (window total ÷ 4) — anchor on lastMonthCents and ` +
      `avgMonthlyCents, never the raw 4-month totalCents, when judging what a bucket costs per month. There is also a ` +
      `household-wide topMerchants list with sharePct, bucketSpread, categorySpread, uncategorizedPct, dominantBucket.\n\n` +
      `Sizing each existing bucket:\n` +
      `- RECURRING: a fixed line item. Set suggestedCapDollars to exactly (debtFloorCents + projectedRecurringCents) in ` +
      `dollars; 0 if that sum is 0. No history anchor, no trim, no adjustment. rationale: one line naming the bill(s).\n` +
      `- MIXED: at least (debtFloorCents + projectedRecurringCents) — the app enforces this floor; size the ` +
      `discretionary room on top from history like a SPEND bucket.\n` +
      `- SPEND: anchor to the bucket's own history (threeMonthAvgCents is the usual anchor), then sanity-check it ` +
      `against household size and its share of income.\n\n` +
      `Trimming a discretionary SPEND/MIXED cap below every historical figure (below leanestRecentCents) is allowed ` +
      `ONLY when the category is genuinely discretionary, its spend is high for this household, AND priorPlanOutcomes ` +
      `shows that bucket running at or under plan for 2+ of the last 3 months (a proven track record of living leaner). ` +
      `Otherwise leanestRecentCents is your floor, and never go below ~55% of threeMonthAvgCents (the app clamps here). ` +
      `When you trim, the rationale MUST name concrete cuts drawn from composition — "drop 2 of the 4 weekly DoorDash ` +
      `orders", "cut the second streaming service" — never a vague "spend less".\n\n` +
      `Never trim an essential bucket (groceries/food, childcare, insurance, anything not clearly discretionary) below ` +
      `what a household of this size plausibly needs — reason that floor from the adult/kid count and the bucket's own ` +
      `history; the underspend-relaxation still applies but the floor is "what they realistically need", not a fraction.\n\n` +
      `Rebalancing: when atBreakeven is true you MAY move room from an over-provisioned discretionary bucket to an ` +
      `underfunded essential one (a big family whose groceries cap sits well below actual spend) — as long as ` +
      `Σ(suggestedCap) is unchanged and the partition still lands on totalMonthlyIncomeCents. Say so in BOTH buckets' ` +
      `rationales ("moved $120 here from Dining"). When atBreakeven is false, only trim — set recommendedSurplusDollars ` +
      `to ~0 and cut discretionary buckets just far enough to reach break even. When atBreakeven is true, set a real ` +
      `positive recommendedSurplusDollars and per-goal savingsAllocations.\n\n` +
      `rationale is one short sentence — the UI shows it as a single small line. Give the REASONING, not a statistic: ` +
      `what drives the number, whether it's sane for this household given its size and what's really in the bucket ` +
      `(composition), and exactly where to cut if you trimmed. Good: "Mostly Amazon ($260) + Target ($140); held at ` +
      `the 3-month average — in line with your income." Bad: "Set to the 3-month average."\n\n` +
      `The surplus DIRECTION (debt vs savings vs split) is NOT yours to choose — the app derives it from goalPosture ` +
      `and routes the money. Your job is surplusExplanation: 2-3 plain sentences stating the monthly surplus figure, ` +
      `where it goes given goalPosture (DEBT_PAYDOWN -> extra principal on debtAttackOrder[0]; SAVINGS_FOCUSED -> ` +
      `savings, dated goals first then a "General Savings" catch-all; BALANCED with attackable debt -> split, weighted ` +
      `toward debt when debtAttackOrder[0]'s APR outpaces the best savingsAccounts APY), and the concrete impact in ` +
      `real numbers (per-paycheck amount, payoff-date shift, or goal completion timing).\n\n` +
      `Splitting a bucket (newBuckets, sourceMerchant null): if a bucket's composition shows a distinct sub-pattern ` +
      `piling up — Home Depot + Lowe's + Ace inside a general "Home" bucket, or all-restaurant spend inside "Misc" — ` +
      `propose a newBuckets entry to break it out, with 2-5 starter category names and a rationale that cites the ` +
      `actual merchants and monthly dollars. Only when the evidence is concrete.\n\n` +
      `Merchant-driven bucket (newBuckets with sourceMerchant set): from the household-wide topMerchants, propose a ` +
      `dedicated bucket for ONE merchant when it is a big share of the household's transaction volume — roughly ` +
      `sharePct >= 15, or clearly the standout by txnCount — AND it's a broad general retailer whose spend is really ` +
      `several different things (Amazon, Walmart, Target, Costco: household goods + snacks + clothes + electronics). ` +
      `This is worth doing EVEN IF those transactions currently all sit in one bucket (bucketSpread/categorySpread 1) ` +
      `— the point is to make that merchant's spend visible on its own. Do NOT propose one for a single-purpose ` +
      `merchant no matter how frequent (a gas station, a single grocery store, a coffee chain — those already belong ` +
      `in Fuel / Groceries / Dining). Set sourceMerchant to the merchant string verbatim from topMerchants, size ` +
      `monthlyCapDollars from its recent monthly total (totalCents is ~4 months), and note in the rationale that its ` +
      `past spend will be routed into the new bucket on confirm. sourceMerchant is null for every other newBuckets ` +
      `entry. At most one or two merchant-driven buckets per plan.\n\n` +
      `Seasonality: given targetMonthNumber (${bi.targetMonthNumber}) and household size, reason about ` +
      `known seasonal load (Nov-Dec gifts/travel, Jun-Aug travel, Aug-Sep back-to-school/kids). If sameMonthLastYearCents ` +
      `or twelveMonthSeries shows a recurring spike for the target month, EITHER raise that bucket's suggestion for the ` +
      `month OR emit a seasonalAlerts entry with suggestSinkingFund=true and a sinkingFundMonthlyDollars that spreads the ` +
      `expected extra across the months until it lands (sinkingFundTargetMonth as "YYYY-MM") — never do both for the same ` +
      `spike. Also emit a seasonalAlerts entry for any savingsGoals entry with monthsUntilTarget <= 2. Empty array if ` +
      `nothing seasonal applies.\n\n` +
      `Learning: priorPlanOutcomes shows how the last few confirmed plans actually went (planned cap vs real spend per ` +
      `bucket). Where a bucket's actual overshot the plan 2+ months running, bias its suggestedCap up and say so in the ` +
      `rationale; where it consistently underspent, trim it.\n\n` +
      `Existing amount rules (budgetInputs.merchantAmountRules): the household may already split a merchant by charge ` +
      `size ("Walmart $60 and up -> Groceries, under $60 -> Retail"). Those bounded rules ALWAYS beat a plain ` +
      `whole-merchant route, so for a merchant listed there a newBuckets entry with routeAmountMinDollars/` +
      `routeAmountMaxDollars both null would route nothing. For such a merchant either set routeAmountMinDollars/` +
      `routeAmountMaxDollars to the band whose purchases should move into the new bucket — reuse an existing band's ` +
      `exact bounds (minCents/maxCents ÷ 100) to take that band over — and size monthlyCapDollars from that band's ` +
      `avgMonthlyCents, or don't propose the merchant bucket at all. Never move a band the household didn't ask to ` +
      `move. A band must be one of two shapes: "up to $X" (routeAmountMinDollars 0, routeAmountMaxDollars X) or "$X ` +
      `and up" (routeAmountMinDollars X, routeAmountMaxDollars null) — never a closed $A–$B window. For a merchant ` +
      `with no amount rules leave both null (route every purchase). Both are null for every ` +
      `non-merchant newBuckets entry.\n\n` +
      `Every newBuckets entry needs 2-5 starter category names and an explicit sourceMerchant (a merchant string, or ` +
      `null). It's fine for newBuckets to be empty.\n\n`
  );
}

// Replaces generateMonthlyFeedback as the Reports page's AI call — same
// "use real numbers, no greeting/sign-off" coaching voice, but now also
// returns structured findings (overspending, new-bucket suggestions,
// detected recurring bills, budgeting issues, plus the priority-ordered
// budgetCorrection/postureSuggestion/bigSurplusOpportunity/
// savingsGoalInsights below) alongside the narrative, and factors in the
// household's goal posture/size, recent trend history, and (when
// current.debt is set) real debt balance/minimums/committed-extra figures
// so the coaching actually improves over time, rather than just restating
// the stated goal as flavor text. Cached by the caller
// (getOrCreateCurrentReport/refreshReportFindings, src/lib/reports.ts) same
// as generateMonthlyFeedback always was.
export async function generateMonthlyReportContent(
  householdId: string,
  current: MonthSummary,
  profile: HouseholdProfileInput,
  trend: ReportTrendEntry[],
): Promise<ReportContent | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const debtGuidance = current.debt
    ? `The household is carrying ${current.debt.totalBalanceCents} cents of debt (${current.debt.totalMinimumsCents} ` +
      `cents/mo in minimums, plus ${current.debt.committedExtraCents} cents/mo already committed as extra toward ` +
      `payoff), leaving an estimated ${current.debt.estimatedMonthlySaveableCents} cents/mo genuinely free for ` +
      `savings after all of that. Compare this against goalPosture: flag it in budgetingIssues if goalPosture is ` +
      `DEBT_PAYDOWN but committedExtraCents is 0 or low relative to the free amount (suggest a concrete extra-` +
      `payment dollar figure), or if goalPosture is SAVINGS_FOCUSED but the free amount is going unused. Say ` +
      `nothing about debt if goalPosture is BALANCED and nothing looks off.\n\n`
    : "";

  const priorityGuidance =
    `The FIRST goal every month is to break even: total income covering every dollar that went out. Bucket spend ` +
    `already includes bucket-assigned debt payments (the mortgage, auto loans, BNPL minimums) — so totalSpentCents ` +
    `and surplus.actualSurplusCents (totalIncomeCents minus total spend, can be negative) are a true "did income ` +
    `cover everything" figure. Judge breakeven ONLY on actualSurplusCents. If it is zero or positive the household ` +
    `broke even this month — say so plainly and do NOT frame the month as a failure or demand a budget realignment, ` +
    `even if individual buckets ran over their caps (an over-cap bucket in a month that still broke even is a note, ` +
    `not an alarm). recurringIncomeCents is planned income for a normal month; when actualSurplusCents is positive ` +
    `only because irregular money landed (actualSurplusCents >= 0 but recurringIncomeCents minus total spend < 0), ` +
    `acknowledge the month cleared but note it leaned on one-off income. surplus.targetMonthlySaveableCents is what ` +
    `they could realistically save given their real caps/debt minimums/committed extra. Work through these in order, ` +
    `and only populate each one when its condition actually applies (null/empty otherwise):\n\n` +
    `1. budgetCorrection: if actualSurplusCents is negative, this is MANDATORY — propose suggestedCuts (existing ` +
    `bucket names only, from the buckets list) whose cutDollars sum to at least the deficit. Prefer trimming ` +
    `discretionary/overspent buckets before anything that looks like an essential recurring bill. Never propose a ` +
    `suggestedCapDollars further below current spend than needed to close the gap — this is a minimal correction, ` +
    `not a budget overhaul. Set to null whenever actualSurplusCents is zero or positive.\n\n` +
    `2. postureSuggestion: only once breakeven-or-better, and only if there's real room to allocate more. If ` +
    `goalPosture is DEBT_PAYDOWN, target debtAttackOrder[0] (already the household's own priority order — don't ` +
    `pick a different debt) with a concrete suggested extra-per-paycheck bump ("DEBT_PAYDOWN"). If SAVINGS_FOCUSED, ` +
    `target the savingsGoals entry with the nearest targetDate (or any goal if none has a date) with a concrete ` +
    `suggested monthly contribution bump ("SAVINGS"). If BALANCED, set this to null UNLESS the household already ` +
    `has a manually-set commitment (debt.committedExtraCents > 0, or an existing savings goal) — in that case ` +
    `report progress on that existing commitment rather than inventing a new push. Never invent a new commitment ` +
    `for a BALANCED household.\n\n` +
    `2b. postureRealignment: only at breakeven-or-better, and ONLY when the stated goalPosture genuinely conflicts ` +
    `with the real debt picture (this is "your goal is wrong", distinct from postureSuggestion's "do more toward ` +
    `your goal"). Classify each debt in debtAttackOrder: "high-cost" = a revolving card/personal loan whose ` +
    `aprBasisPoints is at least ~300bp above the best savingsAccounts apyBasisPoints (or >= 800bp when there's no ` +
    `savings APY on file); "acceptable" = a low-rate mortgage/auto/student loan or a 0%-APR BNPL plan. Then: if ` +
    `goalPosture is SAVINGS_FOCUSED or BALANCED but there's material high-cost debt, suggest DEBT_PAYDOWN (or ` +
    `BALANCED if there's also an urgent near-deadline savings goal or no emergency savings at all). If goalPosture ` +
    `is DEBT_PAYDOWN but every remaining debt is acceptable, suggest SAVINGS_FOCUSED. If there's high-cost debt AND ` +
    `essentially no emergency savings, suggest BALANCED. rationale: one or two sentences with the real APR/APY/` +
    `balance numbers. Null whenever the stated posture already fits.\n\n` +
    `3. bigSurplusOpportunity: only when actualSurplusCents is materially larger than anything already committed ` +
    `(committedExtraCents plus recent goal contributions) — compare debtAttackOrder[0]'s APR against the highest-` +
    `apyBasisPoints entry in savingsAccounts (use whichever is actually higher-value; either debtOption or ` +
    `savingsOption may be null if that side has no data) and recommend the better move in "note". Use ONLY the ` +
    `real numbers given — never name a specific bank product/rate that isn't in the data above. Null when surplus ` +
    `isn't meaningfully large.\n\n` +
    `4. savingsGoalInsights: for each entry in savingsGoals, a short evaluative note (onTrack + why) based on ` +
    `currentAmountCents vs targetAmountCents/targetDate and the household's real saveable capacity — empty array ` +
    `if savingsGoals is empty. This is status reporting, distinct from postureSuggestion's "do this next."\n\n`;

  const budgetPlanGuidance = current.budgetInputs ? budgetPlanGuidanceFor(current.budgetInputs) : "";

  const prompt =
    `You are a friendly, direct household budgeting coach for a household of ${profile.adultsCount} adult(s) and ` +
    `${profile.kidsCount} kid(s) whose stated goal is ${GOAL_POSTURE_PHRASE[profile.goalPosture] ?? "improving their finances"}. ` +
    `The point isn't to just break even — help them actually grow savings/liquid assets and improve habits over time, ` +
    `while being realistic about what's achievable. Bucket caps stay grounded in the household's real spending AND a ` +
    `common-sense read of what's reasonable for a household this size at this income — you may set a lower cap on a ` +
    `genuinely over-provisioned discretionary category even with no realized deficit, but only with specific named cuts ` +
    `in that bucket's rationale, and never below a level that's realistic for this household.\n\n` +
    `oneTimePurchases (when present) are big planned one-time purchases funded from outside regular monthly income ` +
    `(savings, a windfall — e.g. a car down payment). They are already EXCLUDED from buckets, totalSpentCents and ` +
    `totalCapCents: never add them back, never count them toward breakeven, overspending, or any cut. Acknowledge each ` +
    `one in a short neutral clause in the narrative (e.g. "plus the $6,000 Tesla down payment, funded separately").\n\n` +
    `extraIncome (when present, receivedCents > 0) breaks down this month's one-off/P2P income, which is ALREADY ` +
    `INCLUDED in totalIncomeCents — never add it again. appliedCents was automatically used to cover buckets that went ` +
    `over their cap (byBucket; already inside those buckets' capCents); unappliedCents was never needed and is part of ` +
    `this month's surplus (it does not carry over). Mention it briefly in the narrative when it's meaningful.\n\n` +
    `Analyze this month's spending against budget caps (amounts in cents). Use the recent trend history (older -> ` +
    `newer, may be empty for a new household) to note whether an issue is a one-off or a repeating pattern rather ` +
    `than treating this month in isolation.\n\n` +
    debtGuidance +
    priorityGuidance +
    budgetPlanGuidance +
    (current.budgetInputs ? "" : `Set "budgetPlan" to null (no forward budget inputs were provided).\n\n`) +
    `Write "narrative": 3-5 short sentences, specific wins/misses with real dollar amounts, one trend note if the ` +
    `history supports it, and a one-line summary of whatever budgetCorrection/postureSuggestion/postureRealignment/` +
    `bigSurplusOpportunity you're returning below, grounded in the real numbers. No greeting or sign-off — as if ` +
    `texting a spouse a quick budget update.\n\n` +
    `Also return structured findings: overspendingBuckets (buckets over cap this period, with the overspend amount), ` +
    `newBucketSuggestions — as many as genuinely useful (0-3), not just one obvious pick. Actively look for several ` +
    `distinct kinds, not only the most obvious: (1) a merchant that's a large share of this month's spend and is a ` +
    `broad general retailer whose purchases are really several different things (Amazon, Walmart, Target, Costco: ` +
    `household goods + snacks + clothes + electronics), worth breaking out even if it all currently sits inside one ` +
    `existing bucket; (2) something you already flagged elsewhere in this same report — an overspendingBuckets entry ` +
    `or a budgetingIssues note — that would track better as its own bucket instead of staying buried in a broader ` +
    `one; (3) an existing bucket whose spend is really two different things (e.g. "Kids' Activities" mixing ` +
    `recurring sports-league fees with one-off museum/zoo outings) — propose carving the more specific slice into ` +
    `its own bucket, and say in the rationale which existing bucket it's splitting from and why. Every suggestion's ` +
    `rationale must cite real merchants/dollars from this household's data, never a generic guess. Empty array only ` +
    `when nothing genuinely stands out.\n\n` +
    `detectedRecurring (any spend that looks like an undetected recurring bill/subscription), ` +
    `and budgetingIssues (plain-language notes on anything else worth flagging — a cap that's unrealistically ` +
    `low/high given actual spend, a bucket over cap several months running, and the ` +
    `debt-vs-savings mismatch described above when it applies). Only flag "caps exceed income" when the sum of ` +
    `current bucket caps plus lockedObligationsCents genuinely exceeds recurringIncomeCents AND the month also ran ` +
    `a real deficit (actualSurplusCents < 0) — phrase it as next month's plan needing to fit that income, not as a ` +
    `demand to slash budgets now; never raise it in a month that broke even. Any bucket suggestion that's a bill/subscription ` +
    `must use trackingMode "RECURRING" (say so in its rationale — recurring buckets only ever track confirmed ` +
    `bills, never one-off spend); pure discretionary spend gets "SPEND"; use "MIXED" only for a bucket that ` +
    `genuinely needs both.\n\n` +
    `${current.label}: ${JSON.stringify(current)}\n\n` +
    `Recent trend: ${JSON.stringify(trend)}`;

  let parsed = await withTimeout(
    callJson<RawReportContent>(householdId, config, prompt, REPORT_CONTENT_SCHEMA),
    REPORT_AI_TIMEOUT_MS,
  );
  if (!parsed) {
    parsed = await withTimeout(
      callJson<RawReportContent>(householdId, config, prompt, REPORT_CONTENT_SCHEMA),
      REPORT_AI_TIMEOUT_MS,
    );
  }
  return parseReportContent(parsed);
}

// "Tell the AI what you want" on /budget: re-runs only the forward budgetPlan
// block, with the household's own instructions and the draft they're reacting
// to. Same sizing/partition rules as the monthly report's draft
// (budgetPlanGuidanceFor) — the instructions win wherever they conflict with
// a default, and anything they don't touch stays close to the prior draft so
// a "keep my $60 Walmart rule" tweak doesn't reshuffle every other bucket.
export type BudgetRedraftContext = {
  profile: HouseholdProfileInput;
  budgetInputs: NonNullable<MonthSummary["budgetInputs"]>;
  debtAttackOrder: MonthSummary["debtAttackOrder"];
  savingsAccounts: MonthSummary["savingsAccounts"];
  savingsGoals: MonthSummary["savingsGoals"];
};

const BUDGET_REDRAFT_SCHEMA = {
  type: "object",
  properties: { budgetPlan: { ...REPORT_CONTENT_SCHEMA.properties.budgetPlan, nullable: false } },
  required: ["budgetPlan"],
  additionalProperties: false,
};

export async function generateBudgetPlanRedraft(
  householdId: string,
  context: BudgetRedraftContext,
  previousPlan: ReportFindings["budgetPlan"],
  instructions: string,
): Promise<ReportFindings["budgetPlan"]> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const prompt =
    `You are a friendly, direct household budgeting coach for a household of ${context.profile.adultsCount} ` +
    `adult(s) and ${context.profile.kidsCount} kid(s) whose stated goal is ` +
    `${GOAL_POSTURE_PHRASE[context.profile.goalPosture] ?? "improving their finances"}. You already drafted next ` +
    `month's budget; the household reviewed it and wants changes.\n\n` +
    budgetPlanGuidanceFor(context.budgetInputs) +
    `Household instructions (they override the defaults above wherever the two conflict, but never the partition ` +
    `rule, a bucket's debtFloorCents/projectedRecurringCents floor, or the rule against inventing numbers): ` +
    `"""${instructions}"""\n\n` +
    `Apply the instructions, then rebalance only as much as they require — keep every bucket, goal and idea the ` +
    `instructions don't touch close to the previous draft. When the instructions move money between buckets, say ` +
    `so in both buckets' rationales. overallExplanation must open with one sentence on what you changed in ` +
    `response to the instructions.\n\n` +
    `Previous draft: ${JSON.stringify(previousPlan)}\n\n` +
    `budgetInputs: ${JSON.stringify(context.budgetInputs)}\n\n` +
    `debtAttackOrder: ${JSON.stringify(context.debtAttackOrder ?? [])}\n` +
    `savingsAccounts: ${JSON.stringify(context.savingsAccounts ?? [])}\n` +
    `savingsGoals: ${JSON.stringify(context.savingsGoals ?? [])}`;

  type Raw = { budgetPlan: RawReportContent["budgetPlan"] };
  let parsed = await withTimeout(callJson<Raw>(householdId, config, prompt, BUDGET_REDRAFT_SCHEMA), REPORT_AI_TIMEOUT_MS);
  if (!parsed) {
    parsed = await withTimeout(callJson<Raw>(householdId, config, prompt, BUDGET_REDRAFT_SCHEMA), REPORT_AI_TIMEOUT_MS);
  }
  return parseBudgetPlan(parsed?.budgetPlan ?? null);
}

export type StartupReportInput = {
  daysCovered: number;
  totalSpentCents: number;
  totalIncomeCents: number;
  merchantTotals: { merchant: string; amountCents: number; occurrences: number }[];
  detectedBills: { merchant: string; amountCents: number; cadence: string }[];
};

// The onboarding wizard's one-time analysis of whatever sync history exists
// (see getStartupWindowSummary, src/lib/reports.ts) — doubles as the source
// of the wizard's starter-bucket suggestions (findings.newBucketSuggestions),
// so there's no separate "suggest buckets" AI call: one call produces both
// the narrative and the full proposed bucket set.
export async function generateStartupReportContent(
  householdId: string,
  profile: HouseholdProfileInput,
  input: StartupReportInput,
): Promise<ReportContent | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const prompt =
    `You are a household budgeting coach setting up a brand-new budget from ${input.daysCovered} days of real bank ` +
    `transaction history (amounts in cents), for a household of ${profile.adultsCount} adult(s) and ${profile.kidsCount} ` +
    `kid(s) whose stated goal is ${GOAL_POSTURE_PHRASE[profile.goalPosture] ?? "improving their finances"}. The point ` +
    `isn't just to break even — help them grow savings/liquid assets and build better habits, while being realistic: a ` +
    `bucket cap should reflect what they actually spend plus reasonable trimming, not an aspirational number they'll ` +
    `blow through in the first week.\n\n` +
    `Merchant spend totals over the window (amount is the sum of all charges from that merchant, occurrences is how ` +
    `many charges): ${JSON.stringify(input.merchantTotals)}\n\n` +
    `Already-detected recurring bills/subscriptions (clustered by merchant+amount+cadence): ` +
    `${JSON.stringify(input.detectedBills)}\n\n` +
    `Total spend over the window: ${input.totalSpentCents} cents; total income: ${input.totalIncomeCents} cents.\n\n` +
    `Write "narrative": a few sentences introducing this first report — call out where the biggest spend is going and ` +
    `one clear opportunity to improve. No greeting or sign-off.\n\n` +
    `Return structured findings: newBucketSuggestions is the main output here — propose a full starter set of budget ` +
    `buckets (e.g. Groceries, Dining, Bills, Fuel, Subscriptions, and anything else this household's actual spending ` +
    `calls for) with a realistic monthly cap for each based on the real numbers above (and household size where ` +
    `relevant — groceries/dining should scale with adults+kids). Every detected recurring bill above must be grouped ` +
    `into a bucket with trackingMode "RECURRING" and its rationale should explain that recurring buckets only ever ` +
    `track confirmed bills, never one-off spend; genuine one-off/discretionary spend gets "SPEND"; use "MIXED" only ` +
    `for a bucket that genuinely needs both. overspendingBuckets must be an empty array (no buckets exist yet). ` +
    `detectedRecurring should mirror the input list above. budgetingIssues: note anything concerning (e.g. spend ` +
    `regularly exceeding income). This household has no tracked debt, savings goals, or prior months yet, so set ` +
    `budgetCorrection, postureSuggestion, postureRealignment, bigSurplusOpportunity, and budgetPlan to null, and ` +
    `savingsGoalInsights to an empty array — those only apply to the recurring Monthly Report, not this one-time ` +
    `setup report.`;

  const parsed = await callJson<RawReportContent>(householdId, config, prompt, REPORT_CONTENT_SCHEMA);
  return parseReportContent(parsed);
}

export type GoalFeedbackInput = {
  name: string;
  description: string | null;
  targetAmountCents: number;
  targetDate: string | null; // "YYYY-MM-DD"
  currentAmountCents: number;
  pct: number;
  projectedCompletionDate: string | null; // "YYYY-MM-DD"
  recentContributions: { amountCents: number; occurredOn: string }[];
  goalPosture: string;
  householdMonthlyIncomeCents: number;
  householdBucketCapsCents: number;
  householdDebtMinimumsCents: number;
  householdCommittedDebtExtraCents: number;
  estimatedMonthlySaveableCents: number;
  // Deliberate monthly contribution target the household set for this goal in
  // the "Set the Month" budget (SavingsGoal.monthlyTargetCents). 0 = none set.
  monthlyTargetCents: number;
};

// Free-text narrative for one savings goal, grounded in the household's
// real income/budget/debt numbers (computed in TS by
// getHouseholdSavingsCapacity, src/lib/savings.ts — never asked of the
// model) — same "use real numbers, no fabrication" convention as
// generateMonthlyReportContent above. Cached per-goal per-week by the caller
// (see getGoalInsight, src/lib/savings.ts) so this is only ever asked once
// a week per goal, not on every page view. goalPosture and
// householdCommittedDebtExtraCents let this weigh "should this goal actually
// be the priority right now" against the household's stated debt-vs-savings
// goal, not just react to the goal in isolation.
export async function generateGoalFeedback(
  householdId: string,
  input: GoalFeedbackInput,
): Promise<string | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const prompt =
    `You are a friendly, direct household budgeting coach. Below is one savings goal (in JSON, ` +
    `amounts in cents) alongside the household's stated goal posture (goalPosture: DEBT_PAYDOWN, ` +
    `SAVINGS_FOCUSED, or BALANCED), real monthly income, total budget bucket caps, total debt minimum ` +
    `payments, whatever extra they've already committed to paying toward debt each month ` +
    `(householdCommittedDebtExtraCents — already spoken for, not available to this goal), and an ` +
    `estimated monthly amount they could realistically still put toward savings after all of that. ` +
    `Write 2-3 short sentences: say whether the target date (if any) is realistic given the ` +
    `household's actual recent contribution pace versus that estimated saveable amount, and give one ` +
    `concrete, specific suggestion (a dollar amount or a specific change) to help them get there. If ` +
    `goalPosture is DEBT_PAYDOWN and the household is carrying debt, weigh that — don't push them to ` +
    `save harder toward this goal at the expense of debt payoff; if goalPosture is SAVINGS_FOCUSED, ` +
    `push more directly on this goal. Use the real numbers given, not vague language. If ` +
    `monthlyTargetCents is set (> 0), that's the household's committed monthly contribution for this goal — ` +
    `judge pace against it and call out if recent contributions are falling short of it. No greeting, no ` +
    `sign-off — just the feedback, as if texting a spouse a quick update.\n\n` +
    `${JSON.stringify(input)}`;

  return callText(householdId, config, prompt);
}

export type GoalPlanMessage = { role: "user" | "assistant"; content: string };

export type GoalPlanCapacity = {
  householdMonthlyIncomeCents: number;
  householdBucketCapsCents: number;
  householdDebtMinimumsCents: number;
  estimatedMonthlySaveableCents: number;
};

export type GoalPlanProposal = {
  name: string;
  targetAmountCents: number;
  targetDate: string | null; // "YYYY-MM-DD"
  costBreakdown: string | null;
  feedback: string;
  // False only when no realistic plan exists for this goal even after
  // considering a substantially longer timeframe (e.g. estimated monthly
  // saveable capacity is at or near zero) — the UI then offers "enter it
  // manually" instead of "this works" (see AddGoalForm). name/amount/date
  // are still populated even when false, as a best-effort starting point.
  feasible: boolean;
};

const GOAL_PLAN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    targetAmountDollars: { type: "number" },
    targetDate: { type: "string", nullable: true },
    costBreakdown: { type: "string", nullable: true },
    feedback: { type: "string" },
    feasible: { type: "boolean" },
  },
  required: ["name", "targetAmountDollars", "targetDate", "costBreakdown", "feedback", "feasible"],
  additionalProperties: false,
};

// Drives the conversational goal-planning flow (AddGoalForm): the household
// describes what they're saving for in their own words, and this proposes
// (or revises, given the growing conversation) a concrete goal — name,
// amount, date — rather than just validating fields they've already typed
// in. Not cached (see getGoalPlan, src/lib/savings.ts): asked once per
// message sent, not on every render.
//
// Two things this is explicitly asked to do beyond generateGoalFeedback's
// plain review: (1) when the description implies a specific purchase (a
// vehicle, a big appliance, a trip), estimate its real total cost from
// general knowledge — including tax/title/fees or other typical add-ons,
// not just a sticker price — same "general-knowledge ballpark, not a live
// quote" honesty framing as estimateVehicleValue/estimateHomeValue below
// (no live pricing API exists for this app to call); (2) be genuinely
// honest rather than agreeable — if the numbers don't work, say so and
// propose a real alternative (a longer timeframe, a lower amount, or a
// specific budget change), rather than rubber-stamping whatever amount/date
// the household first suggested.
export async function planGoalFromDescription(
  householdId: string,
  messages: GoalPlanMessage[],
  capacity: GoalPlanCapacity,
  today: string,
): Promise<GoalPlanProposal | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const transcript = messages
    .map((m) => `${m.role === "user" ? "Household" : "You"}: ${m.content}`)
    .join("\n\n");

  const prompt =
    `A household is planning a new savings goal through a back-and-forth conversation with you — ` +
    `below is the conversation so far, in their own words, plus their real household numbers ` +
    `(amounts in cents): monthly income, total budget bucket caps, total debt minimum payments, and ` +
    `an estimated monthly amount they could realistically put toward savings after those ` +
    `obligations. "today" is given since you don't otherwise know the current date.\n\n` +
    `Every turn, propose (or revise) a concrete goal: a short name, a target dollar amount, and a ` +
    `target date (YYYY-MM-DD, or null if genuinely open-ended). If they're describing a specific ` +
    `purchase (a vehicle, a big appliance, a trip, a home down payment, etc.), estimate its REAL ` +
    `total cost from your general knowledge — including relevant taxes, fees, or typical add-on ` +
    `costs (sales tax/title/registration for a vehicle, closing costs for a home down payment, etc.) ` +
    `— not just a bare sticker price, and summarize that estimate briefly in costBreakdown (or null ` +
    `if there's no specific item to price out). This is a knowledgeable ballpark from general ` +
    `knowledge, not a live quote — don't claim more precision than that.\n\n` +
    `Be honest in feedback: say plainly whether the amount/timeframe is realistic given their real ` +
    `numbers above, and if it isn't, propose a genuinely workable alternative — a longer timeframe, ` +
    `a lower amount, or (only if it would meaningfully help) a specific spending/budget change they ` +
    `could consider. Never just validate an unrealistic plan to be agreeable. Keep feedback to a few ` +
    `sentences, no greeting or sign-off, as if texting a knowledgeable friend a quick honest take.\n\n` +
    `Set feasible to false only if, even after considering a substantially longer timeframe, there's ` +
    `genuinely no realistic way to work toward this goal given their numbers (e.g. their estimated ` +
    `monthly saveable amount is at or near zero) — in that case say so plainly in feedback and suggest ` +
    `they enter the goal manually with their own numbers instead, but still fill in your best-effort ` +
    `name/targetAmountDollars/targetDate/costBreakdown so there's a starting point if they do. ` +
    `Otherwise set feasible to true.\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Household numbers: ${JSON.stringify({ ...capacity, today })}`;

  const parsed = await callJson<{
    name: string;
    targetAmountDollars: number;
    targetDate: string | null;
    costBreakdown: string | null;
    feedback: string;
    feasible: boolean;
  }>(householdId, config, prompt, GOAL_PLAN_SCHEMA);
  if (!parsed) return null;

  const targetAmountCents = dollarsToCents(Number(parsed.targetAmountDollars));
  if (!Number.isFinite(targetAmountCents) || targetAmountCents <= 0) return null;

  return {
    name: parsed.name?.trim() || "Savings goal",
    targetAmountCents,
    targetDate: parsed.targetDate || null,
    costBreakdown: parsed.costBreakdown || null,
    feedback: parsed.feedback,
    feasible: parsed.feasible,
  };
}

// Either the structured NHTSA-backed year/make/model shape (cars, trucks —
// see vehicle-lookup.ts) or a freeform `description` for anything that
// doesn't fit that lookup — trailers, most of all: NHTSA's own trailer-type
// make list is ~9,500 entries dominated by commercial/semi-trailer
// manufacturers, useless as a picker for a household budget app, so a
// trailer (or anything else odd) just gets described in plain text instead
// and that text goes straight into the estimate prompt below.
export type VehicleEstimateDetails =
  | {
      year: number;
      make: string;
      model: string;
      trim?: string;
      mileage?: number;
      condition?: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
    }
  | {
      description: string;
      condition?: "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
    };

export type HomeEstimateDetails = {
  address: string;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
};

export type AssetEstimate = { valueCents: number; reasoning: string };

const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    valueDollars: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["valueDollars", "reasoning"],
  additionalProperties: false,
};

// General-knowledge ballpark only — no web search/grounding, so this is
// whatever the model already "knows" about typical values, not this week's
// actual listings. Explicitly framed as a rough estimate in the prompt so
// the model doesn't invent false precision, and callers should present it
// the same way (see asset-estimate.ts's monthly refresh + the "estimated,
// not appraised" copy on /networth).
export async function estimateVehicleValue(
  householdId: string,
  details: VehicleEstimateDetails,
): Promise<AssetEstimate | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const subject = "description" in details ? details.description : JSON.stringify(details);

  const prompt =
    `Estimate the current fair market value (private-party sale, USD) of this vehicle, ` +
    `for a household net-worth tracker. Give your best single-number ballpark from your ` +
    `general knowledge of used vehicle pricing — you do not have live listings, so do not ` +
    `claim precision you don't have. Round to the nearest $100.\n\n` +
    `${subject}`;

  return callEstimate(householdId, config, prompt);
}

export async function estimateHomeValue(
  householdId: string,
  details: HomeEstimateDetails,
): Promise<AssetEstimate | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return null;

  const prompt =
    `Estimate the current fair market value (USD) of this home, for a household net-worth ` +
    `tracker. Give your best single-number ballpark from your general knowledge of the local ` +
    `area's real estate market — you do not have live listings or comps, so do not claim ` +
    `precision you don't have. Round to the nearest $1,000.\n\n` +
    `${JSON.stringify(details)}`;

  return callEstimate(householdId, config, prompt);
}

async function callEstimate(householdId: string, config: AiProviderConfig, prompt: string): Promise<AssetEstimate | null> {
  const parsed = await callJson<{ valueDollars: number; reasoning: string }>(householdId, config, prompt, ESTIMATE_SCHEMA);
  if (!parsed) return null;

  const valueCents = dollarsToCents(Number(parsed.valueDollars));
  if (!Number.isFinite(valueCents) || valueCents < 0) return null;

  return { valueCents, reasoning: parsed.reasoning };
}

// One short sentence for the dashboard's "this week's bills" card — same
// graceful-degrade-if-unconfigured contract as generateMonthlyReportContent, and
// cached by the caller (see getUpcomingBillsSummary) so it's only ever
// asked once per household per day.
export async function summarizeUpcomingBills(
  householdId: string,
  bills: {
    name: string;
    amountCents: number;
    dueDate: string;
    paid: boolean;
    // Cents paid toward a debt beyond this cycle's minimum and its planned
    // payoff-plan extra — 0 for a plain bill or a debt paid only to plan.
    extraCents: number;
    // Reimbursement credits netting this bill's payment this cycle (a shared
    // bill someone paid the household back for) — 0 for a debt.
    reimbursedCents: number;
    // This week's payment cleared the debt's balance entirely.
    paysOff: boolean;
  }[],
): Promise<string | null> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config || bills.length === 0) return null;

  const prompt =
    `You are a household budgeting assistant. Below is this week's expected bills/subscriptions/debt payments ` +
    `for a household. Each has an amount in cents (what's owed), a due date, whether it's already paid, ` +
    `an extraCents figure (money put toward a debt on top of the minimum + any payoff plan), a ` +
    `reimbursedCents figure (money someone paid the household back for that bill this cycle), and paysOff ` +
    `(true when this week's payment zeroed that debt). ` +
    `Write ONE short, friendly sentence (no greeting, no sign-off) summarizing what's due and what's still ` +
    `pending — use real dollar amounts, not vague language. If any extraCents are non-zero, mention the ` +
    `total extra put toward debt this week. If any reimbursedCents are non-zero, note the bill's net cost ` +
    `after the reimbursement. If anything has paysOff true, call out that it's now paid off by name.` +
    `\n\n${JSON.stringify(bills)}`;

  return callText(householdId, config, prompt);
}

// --- Email receipt extraction (see src/lib/receipt-sync.ts) ---

export type ParsedReceiptLineItem = {
  description: string;
  qty: number | null;
  unitPriceCents: number | null;
  totalCents: number | null;
};

export type ParsedReceipt = {
  isReceipt: boolean;
  kind: ReceiptKind;
  party: string | null;
  // Only set for P2P payments — whether `party` is an individual person
  // (friend/family) vs a business.
  partyIsPerson: boolean;
  // For a P2P payment — the app it came from ("Venmo", "PayPal", "Cash App",
  // "Zelle", "Apple Cash"). Null for a non-P2P receipt.
  p2pApp: string | null;
  totalCents: number | null;
  currency: string | null; // ISO 4217, uppercased; null when the model couldn't tell
  occurredOn: Date | null;
  orderNumber: string | null;
  noteText: string | null;
  lineItems: ParsedReceiptLineItem[];
  // A merchant refund/return confirmation — see Receipt.isRefund.
  isRefund: boolean;
  refundTo: string | null;
  refundToLast4: string | null;
  // Independent of isReceipt — an email is either a completed-payment
  // receipt, an unpaid amount-due notice, or neither; never both in
  // practice, but the two fields are deliberately not coupled in the schema.
  // See BillNoticeEmail / src/lib/bill-notice-sync.ts.
  billNotice: ParsedBillNotice | null;
};

export type ParsedBillNotice = {
  billerName: string;
  amountDueCents: number;
  dueDate: Date | null;
  accountLast4: string | null;
};

const RECEIPT_KINDS: ReceiptKind[] = [
  "ORDER_CONFIRMATION",
  "PAYMENT_SENT",
  "PAYMENT_RECEIVED",
  "SUBSCRIPTION",
  "SHIPPING",
  "OTHER",
];

const RECEIPT_EXTRACT_SCHEMA = resultsSchema({
  type: "object",
  properties: {
    messageId: { type: "string" },
    isReceipt: { type: "boolean" },
    kind: { type: "string" },
    party: { type: "string", nullable: true },
    partyIsPerson: { type: "boolean" },
    p2pApp: { type: "string", nullable: true },
    totalDollars: { type: "number", nullable: true },
    currency: { type: "string", nullable: true },
    occurredOn: { type: "string", nullable: true },
    orderNumber: { type: "string", nullable: true },
    noteText: { type: "string", nullable: true },
    isRefund: { type: "boolean" },
    refundTo: { type: "string", nullable: true },
    refundToLast4: { type: "string", nullable: true },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number", nullable: true },
          unitPriceDollars: { type: "number", nullable: true },
          totalDollars: { type: "number", nullable: true },
        },
        required: ["description", "quantity", "unitPriceDollars", "totalDollars"],
        additionalProperties: false,
      },
    },
    billNotice: {
      type: "object",
      nullable: true,
      properties: {
        billerName: { type: "string" },
        amountDueDollars: { type: "number" },
        dueDate: { type: "string", nullable: true },
        accountLast4: { type: "string", nullable: true },
      },
      required: ["billerName", "amountDueDollars", "dueDate", "accountLast4"],
      additionalProperties: false,
    },
  },
  required: [
    "messageId",
    "isReceipt",
    "kind",
    "party",
    "partyIsPerson",
    "p2pApp",
    "totalDollars",
    "currency",
    "occurredOn",
    "orderNumber",
    "noteText",
    "isRefund",
    "refundTo",
    "refundToLast4",
    "lineItems",
    "billNotice",
  ],
  additionalProperties: false,
});

type RawExtractedReceipt = {
  messageId: string;
  isReceipt: boolean;
  kind: string;
  party: string | null;
  partyIsPerson: boolean;
  p2pApp: string | null;
  totalDollars: number | null;
  currency: string | null;
  occurredOn: string | null;
  orderNumber: string | null;
  noteText: string | null;
  isRefund?: boolean;
  refundTo?: string | null;
  refundToLast4?: string | null;
  lineItems: {
    description: string;
    quantity: number | null;
    unitPriceDollars: number | null;
    totalDollars: number | null;
  }[];
  billNotice: {
    billerName: string;
    amountDueDollars: number;
    dueDate: string | null;
    accountLast4: string | null;
  } | null;
};

// Prefiltered candidate messages (see looksLikeReceipt) -> structured
// receipt data, batched. Same graceful-degrade contract as every function
// above: no provider / failure -> empty map, and the caller records that
// message as STALE so it's never re-sent. Dollars -> cents in TS. `kind`
// is validated against the enum here (off-list -> OTHER) so a schema-less
// provider can't write a bad enum value downstream.
export async function extractReceipts(
  householdId: string,
  messages: { messageId: string; subject: string; from: string; receivedAt: Date; text: string }[],
): Promise<Map<string, ParsedReceipt>> {
  const result = new Map<string, ParsedReceipt>();
  const config = await getHouseholdAiConfig(householdId);
  if (!config || messages.length === 0) return result;

  const BATCH_SIZE = 10;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const parsed = await extractReceiptBatch(householdId, config, batch);
    for (const [messageId, receipt] of parsed) result.set(messageId, receipt);
  }
  return result;
}

// Null-safe wrapper around money.ts's dollarsToCents — every AI response
// field here is a JSON number the model could still omit or return as
// something non-finite, unlike a form field parseDollarsToCents validates
// up front. Used by every dollars-typed field this file parses out of a
// model response (was reimplemented a second time, identically, elsewhere
// in this file — see WORKING_ON.md).
const toCents = (n: number | null | undefined): number | null =>
  n == null || !Number.isFinite(n) ? null : dollarsToCents(n);

// Null-safe YYYY-MM-DD parser shared by every date field this file pulls out
// of a model response (occurredOn, billNotice.dueDate).
const parseIsoDate = (s: string | null | undefined): Date | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Snap the model's P2P app string to one of the known names (so it lines up
// with the curated merchant-logo table and P2P_DISCOVERY_KEYWORDS); an
// unrecognized value is dropped rather than shown raw.
const P2P_APPS = ["Venmo", "PayPal", "Cash App", "Zelle", "Apple Cash"] as const;
function normalizeP2PApp(raw: string | null | undefined): string | null {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  return P2P_APPS.find((a) => a.toLowerCase().replace(/[^a-z]/g, "") === s) ?? null;
}

async function extractReceiptBatch(
  householdId: string,
  config: AiProviderConfig,
  batch: { messageId: string; subject: string; from: string; receivedAt: Date; text: string }[],
): Promise<Map<string, ParsedReceipt>> {
  const result = new Map<string, ParsedReceipt>();

  const emailBlocks = batch
    .map(
      (m) =>
        `--- messageId: ${m.messageId}\n` +
        `From: ${m.from}\nSubject: ${m.subject}\nReceived: ${m.receivedAt.toISOString().slice(0, 10)}\n\n` +
        m.text,
    )
    .join("\n\n");

  const prompt =
    `You are extracting structured data from emails that may be purchase receipts, order ` +
    `confirmations, subscription receipts, or peer-to-peer payment notifications (Venmo, PayPal, ` +
    `Cash App, Zelle). For EACH email below, return one result object.\n\n` +
    `- "isReceipt": false for anything that is NOT a record of a specific completed transaction — ` +
    `marketing, a shipping notice with no amount, a payment *request* you haven't paid, a periodic ` +
    `bank/card STATEMENT summary (multiple transactions, a billing-cycle total, a minimum-due/due-date ` +
    `notice), a newsletter. When false, the other fields can be null/empty. But a credit card or loan ` +
    `issuer's own confirmation that ONE specific payment posted — "We've received your payment", ` +
    `"Your payment was successful", "Payment received", a Posted date + Payment amount for a single ` +
    `payment — IS a receipt (isReceipt true, kind PAYMENT_SENT) even though it's from the issuer/ ` +
    `lender itself and uses statement-like formatting (an Account/Posted date/Payment amount table); ` +
    `the household's money left their bank and reached this issuer, which is exactly the "completed ` +
    `transaction" this field exists to catch. Only the genuine periodic statement — several ` +
    `transactions, or a balance/due-date summary with no specific payment just received — is the ` +
    `false case. This applies whether the issuer is a Buy Now Pay Later lender (Klarna / Affirm / ` +
    `Afterpay / Zip / Sezzle / PayPal Pay in 4: "Thanks for your payment", "Payment received for ` +
    `<store>", "Amount paid $X") or a traditional credit card / loan servicer (Chase, Citi, Capital ` +
    `One, Discover, a mortgage/auto lender, etc. — "We've received your credit card payment", ` +
    `"Payment received", "Thank you for your payment") — keep isReceipt true even though the same ` +
    `email also shows plan/balance progress ("paid off $X of $Y", a remaining balance, a next-due ` +
    `date); those are context, not the transaction.\n` +
    `- "kind": one of ORDER_CONFIRMATION (bought goods), PAYMENT_SENT, PAYMENT_RECEIVED, SUBSCRIPTION ` +
    `(recurring service receipt), SHIPPING (a shipment notice that still carries an itemized total), ` +
    `OTHER. PAYMENT_RECEIVED also covers a non-P2P notice that real money came BACK to the household ` +
    `from a business or institution — a card issuer's statement/rewards credit, a cashback deposit, a ` +
    `merchant refund or reimbursement confirmation — not just a P2P "X paid you"; don't fall back to ` +
    `OTHER just because there's no person on the other end. For a P2P notification, PAYMENT_SENT vs ` +
    `PAYMENT_RECEIVED is from the MAILBOX OWNER's / ` +
    `their household's side: "You paid X" is SENT; "X paid you" is RECEIVED. A lender or card ` +
    `issuer's own confirmation that a payment posted — BNPL (Klarna/Affirm/Afterpay/etc.) or a ` +
    `traditional credit card/loan servicer (Chase, Citi, Capital One, a mortgage/auto lender) — is ` +
    `PAYMENT_SENT (the household's money went to that issuer/lender), never PAYMENT_RECEIVED, ` +
    `regardless of how statement-like the email's own formatting looks. A "<Person> received a ` +
    `payment" notice (you get these managing a family/teen account) with body "<A> paid <Person>": ` +
    `if <A> is the mailbox owner or an immediate family member (same surname as the account holder / ` +
    `the @handles in the email, or an obvious parent funding a child's account) it is SENT — the ` +
    `household's money went out. If <A> is an unrelated outside individual paying that family member ` +
    `back, it is RECEIVED — the money landed in their app balance, not the household's bank.\n` +
    `- "party": the OTHER side of the transaction as a clean, human-readable name — the merchant ` +
    `("Amazon", "Blue Bottle Coffee", not "SQ *BLUE BOTTLE #4432"), or the person on the other end ` +
    `of a P2P payment. For a BNPL lender's email (sender is Klarna / Affirm / Afterpay / etc.), party ` +
    `is the STORE the purchase was for, NOT the lender — "Payment received for GlassesUSA.com" → ` +
    `"GlassesUSA", "Thanks for your payment ... for Nike" → "Nike". Null if genuinely unclear. Every P2P body has one "<A> paid <B> $<amount>" ` +
    `sentence. For a SENT payment the party is <B>, the name RIGHT AFTER "paid" — verbatim, first ` +
    `name only if that's all it gives, do NOT append a surname it doesn't state ("You paid Sarah", ` +
    `"Morgan Carter paid Taylor", subject "Taylor received a payment" → party "Taylor"). For a ` +
    `RECEIVED payment the party is <A>, the payer ("Pat Carter paid you" → "Pat Carter"; an ` +
    `outsider "Steve Wilcox paid Ryan" → "Steve Wilcox"). Never pick a name just because it is ` +
    `first, longer, or in the subject line.\n` +
    `- "partyIsPerson": for a P2P payment ONLY. TRUE only when "party" is clearly an individual — a ` +
    `personal name like "Danny Roberts", "Sarah M", "Mike". FALSE for anything that reads as a ` +
    `business, brand, studio, team, club, school, or service, even when the name is short, casual, or ` +
    `stylized ("D for Dance Co", "J&M Lawn Care", "CrossFit Downtown", "Mrs. Smith's Piano Studio", ` +
    `"The Sitter Co"). When unsure, prefer FALSE. For any non-P2P receipt, false.\n` +
    `- "p2pApp": for a P2P payment, which app it is — "Venmo", "PayPal", "Cash App", "Zelle", or ` +
    `"Apple Cash" (infer from the sender address or the email's branding). Null for any non-P2P receipt.\n` +
    `- "totalDollars": the amount actually charged or transferred (order total WITH tax and shipping, ` +
    `or the P2P amount). A plain number, no currency symbol. Null if not stated. For a lender/card ` +
    `issuer's own payment confirmation (BNPL or a traditional card/loan servicer) this is the amount ` +
    `of THIS payment (the "Payment amount" / "Amount paid" / "payment of $X received" figure) — never ` +
    `a plan's full price, a remaining/"paid off"/new balance, a minimum due, or the next scheduled ` +
    `payment, even when the same email prints all of those alongside it.\n` +
    `- "currency": ISO 4217 code (e.g. "USD"). Null if you can't tell.\n` +
    `- "occurredOn": the order/payment/transaction date as YYYY-MM-DD. Look for it anywhere in the ` +
    `body — "Paid on", "Transaction date", "Order date", "Order placed", a date printed next to the ` +
    `total or the payment method. Use that, NOT the email's send date, when they differ. Only null if ` +
    `the body genuinely states no date at all. EXCEPTION — a lender/card issuer's own payment ` +
    `confirmation (BNPL or a traditional card/loan servicer): this is the date THIS payment posted ` +
    `("Posted date", "your payment ... was successful on <date>"). If the email doesn't state that ` +
    `date explicitly, return null — do NOT fall back to an original order/agreement date, a statement ` +
    `date, or a next-due date shown elsewhere in the same email, which points at the wrong bank ` +
    `charge (or none at all).\n` +
    `- "orderNumber": the merchant's order / confirmation / invoice / transaction ID, verbatim. Null ` +
    `if none. For a lender/card issuer's own payment confirmation (BNPL or a traditional card/loan ` +
    `servicer), null unless the email gives an ID for THIS payment itself — an account number, a plan's ` +
    `original order number, or a loan/card account ID identifies the plan/account, not this specific ` +
    `payment, and would collide with the plan's own purchase receipt or a different payment on the ` +
    `same account.\n` +
    `- "isRefund": true ONLY when the email confirms a merchant is giving money back for a return, ` +
    `refund, cancellation or price adjustment ("Refund amount", "Your refund has been issued", "We've ` +
    `refunded $X to ..."). totalDollars is then the refunded amount and lineItems the returned items. ` +
    `Use kind PAYMENT_RECEIVED. false for every ordinary purchase, payment, or P2P notice.\n` +
    `- "refundTo": for a refund, the payment method the email says the money goes back to, verbatim ` +
    `("Sam's Club Mastercard", "Visa ending 1234", "original payment method"). Null otherwise.\n` +
    `- "refundToLast4": the last 4 digits of that payment method if the email shows them, else null.\n` +
    `- "noteText": for a P2P payment, the memo/note the sender wrote, verbatim. For any other receipt, ` +
    `a short "what this was for" line the email states (e.g. a subscription plan name, an event name, ` +
    `a service description). Null if there's nothing like that.\n` +
    `- "lineItems": the individual purchased items, each with "description" and, when the email shows ` +
    `them, "quantity", "unitPriceDollars", "totalDollars". Put any size/color/option/variant into the ` +
    `description ("Latte (Large, oat milk)"). ALSO include tax, shipping, delivery fees, service fees, ` +
    `tips, and discounts as their own line items with description "Tax" / "Shipping" / "Delivery fee" / ` +
    `"Service fee" / "Tip" / "Discount" and the amount in "totalDollars" (a discount is negative). ` +
    `Empty array for a P2P payment or when the email has no itemization.\n` +
    `- "billNotice": populate ONLY for a genuine UNPAID amount-due notice — "Your bill is ready", ` +
    `"Amount Due", "Auto Pay is scheduled for $X on <date>", a credit card/loan issuer's statement-` +
    `ready or minimum-due notice. This is the exact statement-summary/minimum-due shape "isReceipt" ` +
    `above excludes — the two fields describe different things about the same email and are never ` +
    `both meaningful: null whenever isReceipt is true (a completed payment, nothing newly "due"), and ` +
    `also null for a full multi-transaction statement with no single due-amount headline, marketing, ` +
    `or anything else. When populated: "billerName" is the same clean, human-readable convention as ` +
    `"party" above (the utility/card/loan company itself, e.g. "Fairview City Water", "Verizon", ` +
    `"PayPal Credit" — never the mailbox owner). "amountDueDollars" is the total amount now due (the ` +
    `minimum payment for a card/loan, or the full bill for a utility/subscription) — a plain number, ` +
    `no currency symbol. "dueDate" is the payment due date as YYYY-MM-DD, null if not stated. ` +
    `"accountLast4" is the last 4 digits of the account/card number ONLY if the email states them ` +
    `explicitly (e.g. "...1234", "ending in 1234") — null otherwise, never guessed.\n\n` +
    `Return "messageId" exactly as given for each.\n\n` +
    `Emails:\n${emailBlocks}`;

  const parsed = await callJson<{ results: RawExtractedReceipt[] }>(
    householdId,
    config,
    prompt,
    RECEIPT_EXTRACT_SCHEMA,
  );
  if (!parsed?.results) return result;

  const byId = new Map(batch.map((m) => [m.messageId, m] as const));
  for (const entry of parsed.results) {
    if (!byId.has(entry.messageId)) continue;
    const kindUpper = (entry.kind ?? "").toUpperCase() as ReceiptKind;
    const kind = RECEIPT_KINDS.includes(kindUpper) ? kindUpper : "OTHER";

    const occurredOn = parseIsoDate(entry.occurredOn);

    const bn = entry.billNotice;
    const billerName = bn?.billerName?.trim();
    const billNotice: ParsedBillNotice | null =
      bn && billerName && Number.isFinite(bn.amountDueDollars)
        ? {
            billerName,
            amountDueCents: dollarsToCents(bn.amountDueDollars),
            dueDate: parseIsoDate(bn.dueDate),
            accountLast4: bn.accountLast4?.trim() || null,
          }
        : null;

    result.set(entry.messageId, {
      isReceipt: Boolean(entry.isReceipt),
      kind,
      party: entry.party?.trim() || null,
      partyIsPerson: Boolean(entry.partyIsPerson),
      p2pApp: normalizeP2PApp(entry.p2pApp),
      totalCents: toCents(entry.totalDollars),
      currency: entry.currency?.trim().toUpperCase() || null,
      occurredOn,
      orderNumber: entry.orderNumber?.trim() || null,
      noteText: entry.noteText?.trim() || null,
      isRefund: Boolean(entry.isRefund),
      refundTo: entry.isRefund ? entry.refundTo?.trim() || null : null,
      refundToLast4: entry.isRefund && /^\d{4}$/.test(entry.refundToLast4?.trim() ?? "") ? entry.refundToLast4!.trim() : null,
      lineItems: Array.isArray(entry.lineItems)
        ? entry.lineItems
            .map((li) => ({
              description: String(li.description ?? "").trim(),
              qty: li.quantity == null || !Number.isFinite(li.quantity) ? null : li.quantity,
              unitPriceCents: toCents(li.unitPriceDollars),
              totalCents: toCents(li.totalDollars),
            }))
            .filter((li) => li.description.length > 0)
        : [],
      billNotice,
    });
  }
  return result;
}
