import { db } from "@/lib/db";
import { getHouseholdAiConfig } from "@/lib/ai-provider";
import { suggestKeywordMatches, type KeywordCheckContext } from "@/lib/ai";
import { clusterByAmount } from "@/lib/amount-tolerance";
import { daysAgo } from "@/lib/period";

// The generic mechanism behind every hardcoded, slow-moving brand-keyword
// list in the app (BNPL_KEYWORDS, SUBSCRIPTION_KEYWORDS, ...) — layers a
// household's own AI-confirmed extras (LearnedKeyword) on top of the static
// list, and finds+asks about new candidates the static list misses
// (checkForNewKeywords), so each list only needs the *stable, well-known*
// entries hardcoded; anything newer is recognized the first time it recurs
// instead of needing a code change. `kind` (plain string, mirrors
// LearnedKeyword.kind/MerchantKeywordCheck.kind in schema.prisma, same
// tagged-string convention as SuggestionDismissal.kind) is what keeps
// different lists' learned keywords/merchant-check caches from colliding —
// see bnpl-detect.ts/bill-detect.ts for the two current callers.

// Static list plus whatever this household's own AI connection has
// confirmed for this kind.
export async function learnedKeywordsFor(householdId: string, kind: string, staticList: string[]): Promise<string[]> {
  const learned = await db.learnedKeyword.findMany({ where: { householdId, kind }, select: { keyword: true } });
  return [...staticList, ...learned.map((k) => k.keyword)];
}

// Finds recurring, still-uncategorized merchants that don't match any known
// keyword (static or household-learned) for this `kind` yet, asks the
// household's own AI connection about each one, and remembers the answer
// forever (MerchantKeywordCheck) — a merchant is only ever asked about a
// given kind once, whether the answer was yes or no. A confirmed match
// becomes a new LearnedKeyword immediately, so its future charges are
// recognized by every keyword-matching call site for this kind exactly like
// one of the hardcoded ones — no separate "AI-detected" code path anywhere
// else.
export async function checkForNewKeywords(
  householdId: string,
  kind: string,
  staticList: string[],
  context: KeywordCheckContext,
): Promise<void> {
  const config = await getHouseholdAiConfig(householdId);
  if (!config) return; // no AI connected — nothing to ask, same as every other AI-optional pass

  const keywords = await learnedKeywordsFor(householdId, kind, staticList);
  const since = daysAgo(120);
  const [txns, checked] = await Promise.all([
    db.transaction.findMany({
      where: {
        householdId,
        amountCents: { gt: 0 },
        occurredOn: { gte: since },
        bucketId: null,
        isTransfer: false,
        isIncome: false,
        debtId: null,
      },
      select: { merchant: true, amountCents: true, occurredOn: true },
    }),
    db.merchantKeywordCheck.findMany({ where: { householdId, kind }, select: { merchant: true } }),
  ]);
  const alreadyChecked = new Set(checked.map((c) => c.merchant));

  const byMerchant = new Map<string, { amountCents: number; occurredOn: Date }[]>();
  for (const t of txns) {
    const norm = t.merchant.trim().toLowerCase();
    if (!norm || alreadyChecked.has(norm) || keywords.some((k) => norm.includes(k))) continue;
    const arr = byMerchant.get(norm) ?? [];
    arr.push({ amountCents: t.amountCents, occurredOn: t.occurredOn });
    byMerchant.set(norm, arr);
  }

  // Recurrence (≥2 similar-amount charges) is the only signal available for
  // a merchant with no keyword to go on at all — a one-off unrecognized
  // merchant is just as likely ordinary uncategorized spend, not worth an AI
  // call to rule out.
  const candidates = [...byMerchant.entries()]
    .filter(([, group]) => clusterByAmount(group).some((c) => c.length >= 2))
    .map(([merchant]) => merchant);
  if (candidates.length === 0) return;

  const guesses = await suggestKeywordMatches(householdId, candidates, context);

  await db.$transaction([
    ...candidates.map((merchant) =>
      db.merchantKeywordCheck.upsert({
        where: { householdId_kind_merchant: { householdId, kind, merchant } },
        create: { householdId, kind, merchant, isMatch: guesses.get(merchant) ?? false },
        update: { isMatch: guesses.get(merchant) ?? false },
      }),
    ),
    ...candidates
      .filter((m) => guesses.get(m))
      .map((keyword) =>
        db.learnedKeyword.upsert({
          where: { householdId_kind_keyword: { householdId, kind, keyword } },
          create: { householdId, kind, keyword },
          update: {},
        }),
      ),
  ]);
}
