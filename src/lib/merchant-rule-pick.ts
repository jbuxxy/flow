// Pure, client-safe half of merchant-rules.ts (which imports `db`) — split
// out so a client component can reach it through merchant-route.ts without
// dragging the Postgres driver into the browser bundle (2026-10-02 build
// break: Turbopack "Can't resolve 'dns'/'fs'" from pg).

// Just the fields pickMerchantRule needs — every caller either has full
// MerchantRule rows (the sync path) or selects this shape explicitly.
export type RuleForPick = {
  amountMinCents: number | null;
  amountMaxCents: number | null;
  source: string;
  confidence: number;
};

// Given every MerchantRule for one merchant, pick the one that applies to a
// transaction of `amountCents`. A bounded override whose [min, max] window
// contains the amount wins over the base rule (NULL/NULL bounds); when more
// than one window matches, the narrowest wins, then USER over AI, then the
// higher confidence. Returns undefined when nothing matches (no rule at all,
// or only bounded rules that exclude this amount and no base rule).
export function pickMerchantRule<T extends RuleForPick>(rules: T[], amountCents: number): T | undefined {
  const amount = Math.abs(amountCents);

  const bounded = rules
    .filter(
      (r): r is T & { amountMinCents: number; amountMaxCents: number } =>
        r.amountMinCents != null &&
        r.amountMaxCents != null &&
        amount >= r.amountMinCents &&
        amount <= r.amountMaxCents,
    )
    .sort((a, b) => {
      const widthDiff = a.amountMaxCents - a.amountMinCents - (b.amountMaxCents - b.amountMinCents);
      if (widthDiff !== 0) return widthDiff;
      if (a.source !== b.source) return a.source === "USER" ? -1 : 1;
      return b.confidence - a.confidence;
    });
  if (bounded.length > 0) return bounded[0];

  return rules.find((r) => r.amountMinCents == null && r.amountMaxCents == null);
}
