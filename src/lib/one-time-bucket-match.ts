// Matches an incoming transaction against a one-time-purchase bucket
// (Bucket.excludedFromAllocation) by amount and merchant name — the only
// deterministic signal available for it, since a MerchantRule would be
// wrong here (a "Tesla" rule would silently claim every future
// Tesla-related charge, including insurance or service, long after the
// down payment itself posts). Used once per sync, before the generic
// debt/P2P defaults, so a stray "contains 'loan'" or minimum-payment
// coincidence can't shadow an actual down payment.
const STOPWORDS = new Set([
  "the", "a", "an", "for", "of", "and", "to", "new", "fund", "funds",
  "payment", "payments", "down", "purchase", "deposit", "fee", "fees",
  "cost", "bill", "expense",
]);

function significantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export type OneTimeBucketCandidate = { id: string; name: string; monthlyCapCents: number };

// `commit: true` means the match is confident enough to auto-file directly
// (bucketId); `commit: false` is a weaker match left as an
// aiSuggestedBucketId hint for a human to confirm via "Needs a Bucket."
export function matchOneTimeBucket(
  buckets: OneTimeBucketCandidate[],
  merchant: string,
  amountCents: number,
): { bucketId: string; commit: boolean } | null {
  const merchantLower = merchant.toLowerCase();
  let hint: { bucketId: string; commit: boolean } | null = null;

  for (const bucket of buckets) {
    if (bucket.monthlyCapCents <= 0) continue;
    const ratio = amountCents / bucket.monthlyCapCents;
    const words = significantWords(bucket.name);
    const nameMatches = words.length > 0 && words.some((w) => merchantLower.includes(w));

    // Name + a ballpark amount (half to 1.5x the target — a down payment
    // rarely lands exactly on the number typed in when the bucket was made)
    // is confident enough to auto-file.
    if (nameMatches && ratio >= 0.5 && ratio <= 1.5) {
      return { bucketId: bucket.id, commit: true };
    }
    // Otherwise a looser signal — the name shows up but the amount is way
    // off, or the amount is very close with no name signal at all (a bucket
    // named just "Down Payment" has nothing to match text against) — is
    // still worth surfacing as a suggestion, not silently dropped.
    if (!hint && ((nameMatches && ratio >= 0.2 && ratio <= 3) || (ratio >= 0.85 && ratio <= 1.15))) {
      hint = { bucketId: bucket.id, commit: false };
    }
  }
  return hint;
}
