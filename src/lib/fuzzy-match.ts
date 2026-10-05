// Lightweight name-similarity scoring (0-1) for "does this debt/lender name
// probably refer to this synced account" — good enough for a suggestion the
// user confirms with one click, no need for anything heavier.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function nameSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  const wordsA = new Set(na.split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(nb.split(" ").filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  // One name's whole word set contained in the other's, even out of order or
  // with an extra word inserted between them — the substring check above only
  // catches a contiguous match, so "Crestline High Flex" vs "Crestline Flex"
  // (a pending-transaction hold's merchant string carrying one extra
  // descriptor word the posted charge drops, real report 2026-09-14) fell
  // through to the word-overlap ratio below and scored 0.75, just under the
  // 0.8 bar callers use to auto-merge a settled twin. Same confidence as the
  // substring tier, just word-aware instead of character-aware.
  const isWordSubset = (small: Set<string>, big: Set<string>) => [...small].every((w) => big.has(w));
  if (isWordSubset(wordsA, wordsB) || isWordSubset(wordsB, wordsA)) return 0.8;

  const shared = [...wordsA].filter((w) => wordsB.has(w));
  if (shared.length === 0) return 0;
  return shared.length / Math.max(wordsA.size, wordsB.size);
}
