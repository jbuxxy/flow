import { db } from "@/lib/db";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { clusterByAmount } from "@/lib/amount-tolerance";
import { learnedKeywordsFor, checkForNewKeywords } from "@/lib/keyword-learning";
import { BNPL_KEYWORDS } from "@/lib/bnpl-keywords";
import { mapConcurrent } from "@/lib/concurrency";

export { BNPL_KEYWORDS };

const KIND = "BNPL";

// The static list plus whatever this household's own AI connection has
// confirmed (LearnedKeyword, kind:"BNPL") — every keyword-matching call site
// in the app (this file, categorizeUncategorizedTransactions/
// simplefin-sync.ts, matchInstallmentPayments/debt-payments.ts) uses this
// instead of the bare static list, so a lender checkForNewBnplLenders
// discovers is found everywhere the hardcoded ones already are, not just
// here.
export async function allBnplKeywords(householdId: string): Promise<string[]> {
  return learnedKeywordsFor(householdId, KIND, BNPL_KEYWORDS);
}

// Every BNPL-identity call site (matchInstallmentPayments/debt-payments.ts,
// categorizeUncategorizedTransactions/simplefin-sync.ts, debt-reassign.ts,
// bill-detect.ts) used to independently re-run
// `keywords.find(k => debt.name.toLowerCase().includes(k))` against the
// live, household-editable `name` on every sync — a debt renamed after its
// BNPL identity was first established (e.g. "Nike - Klarna" → "Nike Shoes")
// silently dropped out of keyword-based attribution, letting a sibling
// plan's payment get misattributed to it instead (real incident,
// 2026-08-22). Debt.bnplKeyword (2026-09-11) is captured once — at plan
// creation (createDebt/createDebtPaymentFromTransaction, debts/actions.ts)
// or, for a plan that predates the field / whose lender wasn't a known
// keyword yet at creation, the first time backfillBnplKeywords below
// successfully matches it — and never changes again, so a later rename
// can't un-match it. Every read site should resolve through this, not
// repeat the bare `.find`/`.some` pattern directly.
export function resolveBnplKeyword(
  debt: { name: string; bnplKeyword?: string | null },
  keywords: string[],
): string | undefined {
  return debt.bnplKeyword ?? keywords.find((k) => debt.name.toLowerCase().includes(k));
}

// Locks in bnplKeyword for every INSTALLMENT debt that doesn't have one yet
// — run once near the start of each household's sync (syncHousehold,
// simplefin-sync.ts), before the read call sites below that benefit from it
// this same pass. Idempotent and self-healing: a debt whose lender wasn't a
// recognized keyword at creation time locks in the moment
// checkForNewBnplLenders teaches the household's AI connection that keyword
// (allBnplKeywords picks up a newly learned one immediately, same as every
// other keyword-matching call site already does) — no migration-time
// backfill script needed, every existing debt heals on its own next sync.
// Never touches a debt that already has one, even if the household renamed
// it since — that's the whole point.
export async function backfillBnplKeywords(householdId: string): Promise<void> {
  const unmatched = await db.debt.findMany({
    where: { householdId, debtType: "INSTALLMENT", bnplKeyword: null },
    select: { id: true, name: true },
  });
  if (unmatched.length === 0) return;
  const keywords = await allBnplKeywords(householdId);
  // Independent per-debt writes — no reason to do them one at a time
  // (2026-09-14 code review; same mapConcurrent this codebase already uses
  // for identical-shape work in simplefin-sync.ts/debt-payments.ts).
  await mapConcurrent(unmatched, 8, async (debt) => {
    const matched = resolveBnplKeyword(debt, keywords);
    if (matched) await db.debt.update({ where: { id: debt.id }, data: { bnplKeyword: matched } });
  });
}

// See checkForNewKeywords' own comment (src/lib/keyword-learning.ts) for the
// full mechanism — this just supplies the BNPL-specific static list and AI
// prompt context.
export async function checkForNewBnplLenders(householdId: string): Promise<void> {
  await checkForNewKeywords(householdId, KIND, BNPL_KEYWORDS, {
    kind: KIND,
    subjectDescription: "Buy Now Pay Later (BNPL) installment lenders",
    examples: "Affirm, Klarna, Afterpay, Sezzle, PayPal Credit, Uplift, Splitit",
    distinguishFrom: "a retailer that merely offers BNPL at checkout, or an ordinary recurring biller",
  });
}

// Tighter than the generic amountToleranceCents (30%/$5 floor) — that band
// is sized for bills whose price legitimately drifts cycle to cycle, but a
// BNPL installment is a fixed amount by design (real variance is a
// sub-dollar rounding trueup on the final payment, e.g. $27.44 -> $27.46).
// Used specifically for "does this charge belong to an already-tracked
// plan" — the generic tolerance's $5 floor was wide enough to swallow a
// genuinely different plan's charge into an existing one just because the
// two happened to be close (real report, 2026-08-21: a new $21.45 Klarna-
// Puma charge got auto-attributed to an unrelated $20.37 Nike-Klarna plan
// instead of surfacing as its own suggestion, since $1.08 sat inside the
// generic $6.11 tolerance for that amount).
export function bnplAttributionToleranceCents(amountCents: number): number {
  return Math.max(Math.round(amountCents * 0.05), 100);
}

export type BnplTransaction = { id: string; merchant: string; amountCents: number; occurredOn: Date };

export type BnplSuggestion = {
  key: string;
  label: string;
  occurrences: number;
  lastAmountCents: number;
  lastSeen: Date;
  transactions: BnplTransaction[];
};

type BnplCluster = { key: string; transactions: BnplTransaction[] };

// The raw clustering pass, shared by detectUnlinkedBnpl (which additionally
// filters out dismissed clusters) and releaseBnplCluster (which needs the
// exact same grouping to find a specific already-dismissed cluster's real
// transactions, dismissal status irrelevant). sinceDays defaults to the
// normal detection window but widens for a one-time backfill/cleanup pass
// that needs to reach further back than a fresh suggestion ever would.
async function computeBnplClusters(householdId: string, sinceDays = 120): Promise<BnplCluster[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const [txns, debts, debtPayments, accounts, keywords] = await Promise.all([
    db.transaction.findMany({
      where: { householdId, amountCents: { gt: 0 }, occurredOn: { gte: since } },
      select: { id: true, merchant: true, amountCents: true, occurredOn: true },
    }),
    db.debt.findMany({ where: { householdId }, select: { id: true, name: true, debtType: true, minPaymentCents: true } }),
    db.debtPayment.findMany({ where: { householdId }, select: { debtId: true, amountCents: true } }),
    db.account.findMany({ where: { householdId }, select: { name: true, orgName: true } }),
    allBnplKeywords(householdId),
  ]);

  // General "already tracked under some other name" suppression — a
  // REVOLVING debt or synced account whose own name happens to contain a
  // BNPL keyword (rare, but possible — a household could name a card
  // "Affirm Visa"). Amount, not name, is what actually tells apart
  // multiple BNPL plans at the same provider — see
  // trackedBnplAmountsByKeyword below, which handles that case instead.
  // Deliberately excludes INSTALLMENT debts — nameSimilarity treats one
  // string containing the other as a match (0.8), and a bare provider
  // charge like "Affirm" is trivially a substring of any tracked plan named
  // "Affirm - <retailer>". Left in, that meant tracking *one* Affirm/Klarna
  // plan silently suppressed every other bare-provider charge in the
  // household forever, hiding a second real untracked plan (real report,
  // 2026-08-21: a second Affirm loan ran its full 5-payment course and paid
  // itself off without ever once being suggested). INSTALLMENT debts are
  // already correctly disambiguated by amount via trackedBnplAmountsByKeyword
  // below, so they don't need to be in this name-based check too.
  const knownNames = [
    ...debts.filter((d) => d.debtType !== "INSTALLMENT").map((d) => d.name),
    ...accounts.flatMap((a) => [a.name, a.orgName ?? ""]),
  ].filter(Boolean);

  // Every already-tracked INSTALLMENT plan's expected amount, grouped by
  // which BNPL keyword its own name matches — a synced transaction that
  // amount-matches one of these is that plan's ongoing history, not a new
  // untracked plan, even though its merchant text also contains the same
  // provider keyword as an actual untracked plan would.
  const debtPaymentAmountByDebtId = new Map(debtPayments.map((p) => [p.debtId, p.amountCents]));
  const trackedBnplAmountsByKeyword = new Map<string, number[]>();
  for (const d of debts) {
    if (d.debtType !== "INSTALLMENT") continue;
    const lowerName = d.name.toLowerCase();
    const keyword = keywords.find((k) => lowerName.includes(k));
    if (!keyword) continue;
    const amount = debtPaymentAmountByDebtId.get(d.id) ?? d.minPaymentCents;
    const arr = trackedBnplAmountsByKeyword.get(keyword) ?? [];
    arr.push(amount);
    trackedBnplAmountsByKeyword.set(keyword, arr);
  }

  const groups = new Map<string, BnplTransaction[]>();
  for (const t of txns) {
    const lower = t.merchant.trim().toLowerCase();
    // Substring match, not exact — unlike categorizeUncategorizedTransactions'
    // sync-time exact-match gate (which only ever needs to catch an
    // *already-tracked* plan's ongoing bare "Klarna" debits), a genuinely
    // active plan's real charges often carry the retailer's name the whole
    // way through, not just on the first one — confirmed directly against
    // this household's real data, 2026-08-16: their 2 actually-active plans
    // ("Nike - Klarna" $20.37, "GlassesUSA.com - Klarna" $13.34) never once
    // appear as bare "Klarna." An exact-match attempt here (same day,
    // reverted) excluded exactly those two real plans while keeping only
    // unrelated bare-"Klarna" noise — wrong tradeoff for a *detection*
    // pass, where under-matching a real active plan is worse than
    // occasionally over-matching a coincidentally-similar one-time
    // purchase (the household's existing dismiss button already handles
    // that case one click at a time).
    const hit = keywords.find((k) => lower.includes(k));
    if (!hit) continue;
    if (knownNames.some((name) => nameSimilarity(t.merchant, name) >= 0.5)) continue;
    const trackedAmounts = trackedBnplAmountsByKeyword.get(hit) ?? [];
    if (trackedAmounts.some((amount) => Math.abs(t.amountCents - amount) <= bnplAttributionToleranceCents(amount)))
      continue;

    const arr = groups.get(hit) ?? [];
    arr.push(t);
    groups.set(hit, arr);
  }

  const clusters: BnplCluster[] = [];
  for (const [keyword, group] of groups) {
    for (const cluster of clusterByAmount(group)) {
      const amountCents = Math.round(cluster.reduce((s, t) => s + t.amountCents, 0) / cluster.length);
      // Amount folded into the key (rounded to the dollar, same convention
      // bill-detect.ts uses) — two plans at the same provider now get their
      // own independent dismiss/track identity instead of colliding on the
      // bare keyword.
      const key = `${keyword}:${Math.round(amountCents / 100)}`;
      clusters.push({ key, transactions: cluster });
    }
  }
  return clusters;
}

// Scans synced spend transactions for known BNPL-provider merchant names
// (Affirm, Klarna, etc.) that aren't already represented by a tracked Debt
// or synced Account — i.e. money leaving the household to a lender Flow
// has no visibility into. Surfaced as a "connect this in SimpleFIN" nudge
// rather than auto-created, since we only have a provider name, not a
// balance/APR to track it manually with.
export async function detectUnlinkedBnpl(householdId: string): Promise<BnplSuggestion[]> {
  const [clusters, dismissals] = await Promise.all([
    computeBnplClusters(householdId),
    db.suggestionDismissal.findMany({ where: { householdId, kind: "BNPL" }, select: { key: true, createdAt: true } }),
  ]);

  // key -> when it was dismissed, not just whether — a bare amount+keyword
  // key (e.g. "klarna:67") is common enough across unrelated plans that a
  // permanent suppression would also hide a genuinely new plan from a
  // different retailer that happens to land on the same rounded dollar
  // amount. Resolved below by only suppressing a cluster whose transactions
  // *all* predate the dismissal — new activity since then re-surfaces it.
  const dismissedAtByKey = new Map(dismissals.map((d) => [d.key, d.createdAt]));

  const suggestions: BnplSuggestion[] = [];
  for (const { key, transactions: cluster } of clusters) {
    const dismissedAt = dismissedAtByKey.get(key);
    if (dismissedAt && cluster.every((t) => t.occurredOn <= dismissedAt)) continue;
    const sorted = [...cluster].sort((a, b) => b.occurredOn.getTime() - a.occurredOn.getTime());
    suggestions.push({
      key,
      // The most recent transaction's actual merchant text, not the matched
      // keyword — keywords like "pay in 4" are generic across providers
      // (PayPal, Affirm, Klarna all use the phrase), so titlecasing the
      // keyword itself would show "Pay In 4" with no way to tell which
      // lender it actually was.
      label: sorted[0].merchant,
      occurrences: cluster.length,
      lastAmountCents: sorted[0].amountCents,
      lastSeen: sorted[0].occurredOn,
      transactions: sorted,
    });
  }
  return suggestions;
}

// Releases every transaction behind a specific BNPL suggestion key back to
// ordinary isTransfer:false/debtId:null spend, so it flows through normal
// bucket/AI categorization instead of sitting in limbo forever as neither
// budgeted spend nor a real debt payment. Paired with dismissing the
// suggestion (dismissBnplSuggestion, src/app/debts/actions.ts) — "no thanks,
// not tracking this" should actually resolve the data, not just hide the
// card. Also matters for a *different* tracked plan sharing the same
// provider keyword: an unresolved, unrelated charge sitting around forever
// is exactly what let an untracked Klarna plan's own charge silently steal
// a turn in another Klarna plan's own payment matching (real report,
// 2026-08-24 Nike Klarna incident — see matchInstallmentPayments).
//
// Safe to call right after tracking the same key as a real Debt too (the
// "Track as an installment plan" path also calls dismissBnplSuggestion) —
// createDebt's own matchInstallmentPayments call already runs first and
// claims whatever it can (setting debtPaymentId), so the `debtPaymentId:
// null` guard below only ever releases the stragglers that plan didn't
// actually claim, never a transaction that just became a real payment.
export async function releaseBnplCluster(householdId: string, key: string, sinceDays?: number): Promise<void> {
  const clusters = await computeBnplClusters(householdId, sinceDays);
  const cluster = clusters.find((c) => c.key === key);
  if (!cluster || cluster.transactions.length === 0) return;

  await db.transaction.updateMany({
    where: { id: { in: cluster.transactions.map((t) => t.id) }, debtPaymentId: null },
    data: { isTransfer: false, debtId: null },
  });
}

