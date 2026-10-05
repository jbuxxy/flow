// Text for the "N results" line under a filterable/searchable list. Kept pure
// (no JSX) so it's unit-tested; <ResultCount> (src/components/result-count.tsx)
// is the thin aria-live wrapper around it.
//
//   formatResultCount(12)                               -> "12 Results"
//   formatResultCount(1)                                -> "1 Result"
//   formatResultCount(12, { noun: "Transaction", total: 340 }) -> "12 of 340 Transactions"
//   formatResultCount(340, { noun: "Transaction", total: 340 }) -> "340 Transactions"

function pluralize(noun: string): string {
  if (/(s|x|z|ch|sh)$/i.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/i.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

export function formatResultCount(
  count: number,
  opts?: { noun?: string; total?: number },
): string {
  const noun = opts?.noun ?? "Result";
  const total = opts?.total;
  if (total != null && total !== count) {
    return `${count} of ${total} ${pluralize(noun)}`;
  }
  return `${count} ${count === 1 ? noun : pluralize(noun)}`;
}
