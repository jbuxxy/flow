// Runs `fn` over `items` with at most `limit` in flight at once — the
// middle ground between a fully sequential `for (const x of items) await
// fn(x)` loop (safe but slow: one DB round trip at a time even though nothing
// about the rows actually depends on each other) and a bare
// `Promise.all(items.map(fn))` (fast but unbounded: a sync with a few
// hundred transactions would fire a few hundred concurrent writes and can
// exhaust Postgres's connection pool). Used by simplefin-sync.ts's
// per-transaction upsert loop and per-candidate auto-categorization loop —
// both do independent, per-row work with no shared mutable state (order
// doesn't matter, and `fn` is expected to handle its own errors if a single
// row failing shouldn't abort the rest).
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
}
