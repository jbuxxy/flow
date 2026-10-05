import { pickMerchantRule, type RuleForPick } from "@/lib/merchant-rule-pick";

// Pure — no `db`. What routing a merchant into a new bucket would actually
// move, given that merchant's existing MerchantRules.
//
// A budget-plan "give Walmart its own bucket" idea used to carve the
// merchant's whole monthly average out of its biggest current bucket and, on
// confirm, rewrite only the merchant's *base* rule — but a bounded amount
// rule always beats the base rule (pickMerchantRule), so a household with
// "Walmart $60+ -> Groceries" and "Walmart under $60 -> Retail" would have
// lost $1,037 of Groceries budget while every future Walmart charge kept
// landing exactly where it did before (real report, 2026-10-02).
//
// `band` null = route every purchase (a base rule); otherwise a bounded rule
// over [minCents, maxCents] that replaces any existing rule on that exact
// window (setBoundedMerchantRule's own upsert key). Returns, per bucket the
// moved transactions sit in today, their total — the caller turns that into
// a monthly carve.

export type RouteBand = { minCents: number; maxCents: number };

const NEW_RULE_SOURCE = "__route__";

export function simulateMerchantRoute(
  rules: RuleForPick[],
  band: RouteBand | null,
  txns: { amountCents: number; bucketId: string | null }[],
): { movedCentsByBucket: Map<string | null, number>; movedCount: number } {
  const newRule: RuleForPick = {
    amountMinCents: band ? band.minCents : null,
    amountMaxCents: band ? band.maxCents : null,
    source: NEW_RULE_SOURCE,
    confidence: 1,
  };
  const kept = rules.filter((r) =>
    band
      ? !(r.amountMinCents === band.minCents && r.amountMaxCents === band.maxCents)
      : !(r.amountMinCents == null && r.amountMaxCents == null),
  );
  const nextRules = [...kept, newRule];

  const movedCentsByBucket = new Map<string | null, number>();
  let movedCount = 0;
  for (const t of txns) {
    if (pickMerchantRule(nextRules, t.amountCents) !== newRule) continue;
    movedCount += 1;
    movedCentsByBucket.set(t.bucketId, (movedCentsByBucket.get(t.bucketId) ?? 0) + Math.abs(t.amountCents));
  }
  return { movedCentsByBucket, movedCount };
}

// "under $60" / "$60 and up" / "$20–$60" — for the allocator's route toggle.
// maxCents at or past BAND_OPEN_MAX_CENTS reads as open-ended.
export const BAND_OPEN_MAX_CENTS = 1_000_000_00;

export function describeRouteBand(band: RouteBand): string {
  const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (band.minCents <= 0) return `up to ${dollars(band.maxCents)}`;
  if (band.maxCents >= BAND_OPEN_MAX_CENTS) return `${dollars(band.minCents)} and up`;
  return `${dollars(band.minCents)}–${dollars(band.maxCents)}`;
}
