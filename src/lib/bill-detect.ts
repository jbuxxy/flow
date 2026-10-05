import { db } from "@/lib/db";
import { allBnplKeywords } from "@/lib/bnpl-detect";
import { nextBillDueDate, amountToleranceCents } from "@/lib/recurring-bills";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { learnedKeywordsFor, checkForNewKeywords } from "@/lib/keyword-learning";
import type { BillCadence } from "@prisma/client";

export type BillSuggestion = {
  key: string;
  merchant: string;
  amountCents: number;
  cadence: BillCadence;
  nextDueDate: Date;
  lastSeenDate: Date;
  occurrences: number;
  transactionIds: string[];
  aiSuggestedBucketId: string | null;
  // Set only for a suggestion detected from a checking-side payment toward
  // a tracked REVOLVING Debt (see detectDebtPaymentSuggestions in
  // debt-payments.ts) — accepting one of these creates a DebtPayment
  // instead of a RecurringBill (see acceptDebtPaymentSuggestion in
  // src/app/debts/actions.ts), matched by debtId rather than merchant text.
  debtId: string | null;
  // Only meaningful when debtId is set — lets the client default to a
  // "Card payment" category guess instead of "Loan payment" for a debt
  // that's actually a credit card (see acceptDebtPaymentSuggestion's
  // matching find-or-create logic).
  isCreditCard: boolean;
};

export const DAY_MS = 86_400_000;

// Same shape as classifyCadence in income-detect.ts, but bills span a wider
// range of real-world cadences (a weekly cleaning service, an annual domain
// renewal) than a paycheck ever does.
export function classifyCadence(gaps: number[]): { cadence: BillCadence } | null {
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const maxDev = Math.max(...gaps.map((g) => Math.abs(g - avg)));
  if (avg >= 5 && avg <= 9 && maxDev <= 2) return { cadence: "WEEKLY" };
  if (avg >= 12 && avg <= 16 && maxDev <= 3) return { cadence: "BIWEEKLY" };
  if (avg >= 25 && avg <= 35 && maxDev <= 5) return { cadence: "MONTHLY" };
  if (avg >= 350 && avg <= 380 && maxDev <= 15) return { cadence: "ANNUAL" };
  return null;
}

// Tightest window (in units) that contains every value on a wrap-around
// scale — day-of-month on a 31 scale (so the 31st and the 1st are 1 apart,
// not 30), day-of-week on a 7 scale. `period - largest gap between adjacent
// sorted values (wrap included)`.
function circularSpread(values: number[], period: number): number {
  if (values.length <= 1) return 0;
  const s = [...values].sort((a, b) => a - b);
  let maxGap = s[0] + period - s[s.length - 1]; // the wrap gap
  for (let i = 1; i < s.length; i++) maxGap = Math.max(maxGap, s[i] - s[i - 1]);
  return period - maxGap;
}

// A real recurring bill lands on roughly the same calendar anchor every
// cycle — the 3rd of the month, the 15th. classifyCadence only looks at the
// *average gap* between charges, and a 25–35-day window is a wide target that
// a high-frequency variable-spend merchant clears on volume alone: this
// household has 400+ "Amazon" purchases, so some price-band slice of them
// always averages ~30 days apart with no monthly anchor behind it, and the
// household had to dismiss a fresh bogus "Amazon — $NN/mo" bill roughly
// weekly (real report, 2026-09-09). Requiring the occurrences to actually
// cluster on a day-of-month kills that whole class of false positive.
//
// Only meaningful for MONTHLY/ANNUAL — WEEKLY/BIWEEKLY already have a tight
// maxDev gap check in classifyCadence, and layering a day-of-week constraint
// risks rejecting a legitimately holiday-shifted weekly service. A tolerance
// of 3 days absorbs "first business day" drift and a "31st" bill landing on
// the 28th/30th in a short month.
export function hasRegularCadenceAnchor(dates: Date[], cadence: BillCadence): boolean {
  if (dates.length < 3) return true; // MIN_OCCURRENCES already gates the count
  if (cadence !== "MONTHLY" && cadence !== "ANNUAL") return true;
  return circularSpread(dates.map((d) => d.getUTCDate()), 31) <= 3;
}

// How stale a cluster's most recent occurrence can be and still read as an
// *active* recurring charge worth suggesting — a couple of missed cycles
// (a paused subscription, a cancelled service, or just a coincidental
// cadence that has since fallen apart) shouldn't keep nagging. Generous
// (2 cadence periods) so a genuinely late bill isn't dropped.
const CADENCE_PERIOD_DAYS: Record<BillCadence, number> = {
  WEEKLY: 7,
  BIWEEKLY: 14,
  MONTHLY: 31,
  ANNUAL: 366,
};

export function isCadenceStale(lastSeen: Date, cadence: BillCadence, now: Date = new Date()): boolean {
  return now.getTime() - lastSeen.getTime() > 2 * CADENCE_PERIOD_DAYS[cadence] * DAY_MS;
}

// Two occurrences give a single gap with zero variance to check — any pair
// of same-ish charges roughly N days apart trivially "fits" a cadence
// perfectly (maxDev is always 0), which is exactly how a one-off coincidence
// like two Cafe Verde visits two weeks apart used to get suggested as a
// recurring bill. Three-plus occurrences actually exercise maxDev, so a
// truly irregular history gets rejected instead of rubber-stamped. Kept at
// 2 for ANNUAL only, since the 400-day lookback below physically can't ever
// contain a 3rd occurrence of anything a year apart, and two charges ~365
// days apart is already a very unlikely coincidence on its own.
export const MIN_OCCURRENCES: Record<BillCadence, number> = {
  WEEKLY: 3,
  BIWEEKLY: 3,
  MONTHLY: 3,
  ANNUAL: 2,
};

// Same threshold/tier matchBillPayments uses for the same reason (statement
// text drifting cycle to cycle, e.g. "Netflix" vs "Netflix.com") — 0.75 sits
// just below nameSimilarity's "one string contains the other" tier (0.8).
const NAME_SIMILARITY_THRESHOLD = 0.75;

// Well-known subscription services — a household recognizes these by name
// alone, so waiting for MIN_OCCURRENCES worth of history before suggesting
// one (the right default for an unknown merchant, where cadence is the only
// evidence available at all) just means a Netflix charge sits unsuggested
// for 2-3 months first. Substring match on trimmed/lowercased merchant text,
// same convention as BNPL_KEYWORDS. Not exhaustive — a household's own
// less-common subscription still gets caught by the normal cadence detector
// below, just after real history accumulates like any other bill.
export const SUBSCRIPTION_KEYWORDS = [
  "netflix",
  "spotify",
  "hulu",
  "disney+",
  "disney plus",
  "hbo max",
  "max.com",
  "youtube premium",
  "youtube tv",
  "amazon prime",
  "audible",
  "apple music",
  "apple tv",
  "apple one",
  "icloud",
  "paramount+",
  "peacock",
  "playstation plus",
  "xbox game pass",
  "nintendo switch online",
  "sirius xm",
  "siriusxm",
  "planet fitness",
  "la fitness",
  "crunch fitness",
  "anytime fitness",
  "new york times",
  "nytimes",
  "wall street journal",
  "dropbox",
  "adobe",
  "microsoft 365",
  "office 365",
  "google one",
  "google storage",
  "patreon",
  "twitch",
];

const SUBSCRIPTION_KIND = "SUBSCRIPTION";

// The static list plus whatever this household's own AI connection has
// confirmed (LearnedKeyword, kind:"SUBSCRIPTION") — same mechanism as
// allBnplKeywords (src/lib/bnpl-detect.ts), see keyword-learning.ts for the
// shared implementation both wrap.
export async function allSubscriptionKeywords(householdId: string): Promise<string[]> {
  return learnedKeywordsFor(householdId, SUBSCRIPTION_KIND, SUBSCRIPTION_KEYWORDS);
}

// See checkForNewKeywords' own comment (src/lib/keyword-learning.ts) — this
// just supplies the subscription-specific static list and AI prompt
// context. Called from syncHousehold (simplefin-sync.ts) alongside
// checkForNewBnplLenders.
export async function checkForNewSubscriptions(householdId: string): Promise<void> {
  await checkForNewKeywords(householdId, SUBSCRIPTION_KIND, SUBSCRIPTION_KEYWORDS, {
    kind: SUBSCRIPTION_KIND,
    subjectDescription: "well-known consumer subscription services (streaming, software, gym memberships, and similar)",
    examples: "Netflix, Spotify, Hulu, Disney+, Adobe, Planet Fitness",
    distinguishFrom: "a one-time purchase, an ordinary recurring bill like utilities or insurance, or a BNPL installment plan",
  });
}

function isKnownSubscription(merchant: string, subscriptionKeywords: string[]): boolean {
  const key = merchant.trim().toLowerCase();
  return subscriptionKeywords.some((k) => key.includes(k));
}

export async function getDismissedBillKeys(householdId: string): Promise<Set<string>> {
  const dismissals = await db.suggestionDismissal.findMany({ where: { householdId, kind: "BILL" }, select: { key: true } });
  return new Set(dismissals.map((d) => d.key));
}

// Scans synced spend (money-out) transactions for a merchant repeating on a
// steady cadence — the outgoing-side mirror of detectRecurringIncome.
// Surfaced as a one-click "track this bill" suggestion rather than
// auto-created, same as every other AI/heuristic suggestion in this app.
// Merchant-only (see detectDebtPaymentSuggestions in debt-payments.ts for
// the debt-payment half) —
// callers filter/place these by `aiSuggestedBucketId` (each Bucket's own
// page shows the suggestions guessed to belong to it; see buckets/[id]).
export async function detectMerchantBillSuggestions(householdId: string): Promise<BillSuggestion[]> {
  const since = new Date(Date.now() - 400 * DAY_MS);
  const [txns, existingBills, dismissedKeys, bnplKeywords, subscriptionKeywords] = await Promise.all([
    db.transaction.findMany({
      where: {
        householdId,
        amountCents: { gt: 0 },
        isTransfer: false,
        occurredOn: { gte: since },
        // A still-pending transaction's merchant/date are provisional —
        // SimpleFIN often sends a placeholder ("PENDING - 09/22 - ...")
        // that overwrites itself once the bank posts for real (see
        // simplefin-sync.ts's own upsert comment on this). Suggesting a
        // brand-new bill off that placeholder text risks a bogus/duplicate
        // suggestion — e.g. it drifting from an *existing* tracked bill's
        // merchant text and spawning a "new bill" suggestion for something
        // already tracked (household report, 2026-09-22: a pending charge
        // with unstable merchant text). A pending transaction can
        // still MATCH an existing bill just fine — matchBillPayments
        // (recurring-bills.ts) has no pending filter of its own — this
        // exclusion is scoped to the "propose something new" engine only.
        pending: false,
      },
      orderBy: { occurredOn: "asc" },
      select: {
        id: true,
        merchant: true,
        amountCents: true,
        occurredOn: true,
        bucketId: true,
        aiSuggestedBucketId: true,
      },
    }),
    db.recurringBill.findMany({ where: { householdId, merchant: { not: null } }, select: { merchant: true } }),
    getDismissedBillKeys(householdId),
    allBnplKeywords(householdId),
    allSubscriptionKeywords(householdId),
  ]);

  const trackedMerchants = new Set(existingBills.map((b) => b.merchant!.toLowerCase()));

  const exactGroups = new Map<string, typeof txns>();
  for (const t of txns) {
    const key = t.merchant.trim().toLowerCase();
    if (trackedMerchants.has(key)) continue;
    // A BNPL plan (Affirm, Klarna, "Pay in 4", ...) has a fixed number of
    // installments and then stops — RecurringBill has no concept of that,
    // it only ever rolls nextDueDate forward forever, so tracking one here
    // would keep expecting a payment indefinitely after the plan's actually
    // paid off. These belong in detectUnlinkedBnpl/BnplSuggestions on
    // /debts instead, tracked as a real INSTALLMENT Debt that knows its own
    // remaining payment count.
    if (bnplKeywords.some((k) => key.includes(k))) continue;
    const arr = exactGroups.get(key) ?? [];
    arr.push(t);
    exactGroups.set(key, arr);
  }

  // Merges near-duplicate merchant text (e.g. a bank feed showing "Netflix"
  // one month and "Netflix.com" the next) before amount-clustering below —
  // same threshold/reasoning matchBillPayments already uses to match a
  // synced payment back to its bill despite statement-text drift.
  const merchantClusters: typeof txns[] = [];
  const consumed = new Set<string>();
  for (const key of exactGroups.keys()) {
    if (consumed.has(key)) continue;
    let combined = exactGroups.get(key)!;
    for (const other of exactGroups.keys()) {
      if (other === key || consumed.has(other)) continue;
      if (nameSimilarity(key, other) >= NAME_SIMILARITY_THRESHOLD) {
        combined = combined.concat(exactGroups.get(other)!);
        consumed.add(other);
      }
    }
    merchantClusters.push(combined);
  }

  // Sub-clusters each merchant's transactions by amount before checking for
  // a cadence — grouping by merchant text alone made a fixed-price
  // subscription invisible whenever it shared a merchant string with
  // everyday variable-amount spend at the same retailer (a $12.95/mo
  // Walmart+ fee is just noise inside hundreds of differently-priced
  // Walmart grocery runs, and the combined blob's transaction gaps — often
  // multiple times a week — never resemble any real bill cadence either).
  // Greedy 1D clustering sorted by amount, same tolerance markBillPayments
  // uses to match a bill to a slightly-off real charge.
  function clusterByAmount(group: typeof txns): (typeof txns)[] {
    const sorted = [...group].sort((a, b) => a.amountCents - b.amountCents);
    const clusters: (typeof txns)[] = [];
    for (const t of sorted) {
      const current = clusters[clusters.length - 1];
      const avg = current ? current.reduce((s, x) => s + x.amountCents, 0) / current.length : 0;
      if (current && Math.abs(t.amountCents - avg) <= amountToleranceCents(avg)) {
        current.push(t);
      } else {
        clusters.push([t]);
      }
    }
    return clusters;
  }

  const suggestions: BillSuggestion[] = [];
  for (const merchantCluster of merchantClusters) {
    for (const group of clusterByAmount(merchantCluster)) {
      // Re-sort into chronological order — clusterByAmount left it sorted by
      // amount, but cadence classification needs date order.
      group.sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime());

      const last = group[group.length - 1];
      const dates = group.map((t) => t.occurredOn);
      const knownSubscription = isKnownSubscription(last.merchant, subscriptionKeywords);

      // A known subscription merchant is its own evidence — no need to wait
      // for a second charge to prove a cadence exists at all. Default to
      // MONTHLY (the overwhelming common case for this list); wrong for the
      // rare household paying one of these annually, but that's a one-click
      // fix via the normal edit-bill form after tracking, same as any other
      // suggestion whose guessed amount/category needs a human correction.
      let cadence: BillCadence;
      if (group.length < 2) {
        if (!knownSubscription) continue;
        cadence = "MONTHLY";
      } else {
        const gaps = group.slice(1).map((t, i) => (t.occurredOn.getTime() - group[i].occurredOn.getTime()) / DAY_MS);
        const classified = classifyCadence(gaps);
        if (classified) {
          cadence = classified.cadence;
        } else if (knownSubscription) {
          cadence = "MONTHLY";
        } else {
          continue;
        }
        if (!knownSubscription && group.length < MIN_OCCURRENCES[cadence]) continue;
      }

      // Once there's a real history to judge — MIN_OCCURRENCES worth — the
      // rhythm has to actually hold, KNOWN SUBSCRIPTION OR NOT. A brand name
      // earns a leap of faith on a *thin* history (a first charge or two),
      // never on a scattered pile: a household's own AI once learned bare
      // "amazon" as a SUBSCRIPTION keyword, and every price band of their
      // Amazon spending then surfaced as a monthly bill, un-dismissably (real
      // report, 2026-09-10). A genuine subscription seen 9× lands on the same
      // day every month and sails straight through hasRegularCadenceAnchor.
      const enoughToJudge = group.length >= MIN_OCCURRENCES[cadence];
      if (enoughToJudge && !hasRegularCadenceAnchor(dates, cadence)) continue;
      // A cluster whose most recent charge is 2+ cycles old isn't an active
      // recurring bill. A known subscription with only a thin history keeps
      // the benefit of the doubt (an annual plan billed once, months back,
      // still guesses MONTHLY here) — but once it has a real history, a lapse
      // means it was cancelled.
      if ((enoughToJudge || !knownSubscription) && isCadenceStale(last.occurredOn, cadence)) continue;

      const amountCents = Math.round(group.reduce((s, t) => s + t.amountCents, 0) / group.length);
      // Prefer an already-bucketed occurrence (a merchant rule caught it
      // between when it happened and now) over a mere AI guess, and the most
      // recent one of whichever kind's available — same "best available
      // signal" reasoning as the "Needs a bucket" queue's default selection.
      const bucketHint =
        [...group].reverse().find((t) => t.bucketId)?.bucketId ??
        [...group].reverse().find((t) => t.aiSuggestedBucketId)?.aiSuggestedBucketId ??
        null;

      // Amount folded into the key (rounded to the dollar) — a merchant can
      // now surface more than one suggestion (e.g. a base subscription plus
      // a separate add-on fee at the same retailer), and each needs its own
      // stable dismiss/accept identity instead of colliding on merchant text
      // alone. Checked here (post-clustering) rather than as an early
      // per-transaction filter, since dismissing one amount-variant must not
      // hide a different, undismissed one at the same merchant.
      const key = `${last.merchant.trim().toLowerCase()}:${Math.round(amountCents / 100)}`;
      if (dismissedKeys.has(key)) continue;

      suggestions.push({
        key,
        merchant: last.merchant,
        amountCents,
        cadence,
        nextDueDate: nextBillDueDate(cadence, last.occurredOn, group.map((t) => t.occurredOn)),
        lastSeenDate: last.occurredOn,
        occurrences: group.length,
        transactionIds: group.map((t) => t.id),
        aiSuggestedBucketId: bucketHint,
        debtId: null,
        isCreditCard: false,
      });
    }
  }

  return suggestions;
}
