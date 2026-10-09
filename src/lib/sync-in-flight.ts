// Every bank sync currently running in this process, so a background job
// that reads what a sync writes can wait for it to settle first. A sync
// imports transactions several steps before it matches receipts and
// links refunds, so a reader landing mid-sync sees a half-processed import
// — real report, 2026-10-08: the refund-review nudge ran 1s after a $16.13
// Sam's Club credit imported and 7s before its receipt linked it to the
// purchase, pushing "1 Refund Needs Review" for a refund that never needed
// one. Kept on globalThis (like instrumentation.ts's intervals) since the
// startup poller and a server action can load separate module instances.
const g = globalThis as unknown as {
  __flowSyncsInFlight?: Set<Promise<unknown>>;
  __flowSyncsByKey?: Map<string, Promise<unknown>>;
};
const inFlight = (g.__flowSyncsInFlight ??= new Set());
const byKey = (g.__flowSyncsByKey ??= new Map());

export function trackSync<T>(sync: Promise<T>): Promise<T> {
  inFlight.add(sync);
  const done = () => inFlight.delete(sync);
  sync.then(done, done);
  return sync;
}

// Resolves once no sync is running — including any that start while it's
// waiting on an earlier one. Never rejects; a failed sync still counts as
// finished.
export async function whenSyncsIdle(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

// At most one run per key (a household) at a time: a second caller while one
// is running gets the running one's promise instead of starting another.
// Two concurrent syncs of the same household (the 20-minute poller plus Sync
// Now, or a poll outlasting its interval) each read the same tracker state
// and advanced it — minimums accrued twice, ad-hoc top-ups drawn twice for
// one overage (2026-10-08 review). In-process only: the app runs as a
// single container.
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = byKey.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run();
  byKey.set(key, p);
  const done = () => {
    if (byKey.get(key) === p) byKey.delete(key);
  };
  p.then(done, done);
  return p;
}
