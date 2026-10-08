// Every bank sync currently running in this process, so a background job
// that reads what a sync writes can wait for it to settle first. A sync
// imports transactions several steps before it matches receipts and
// links refunds, so a reader landing mid-sync sees a half-processed import
// — real report, 2026-10-08: the refund-review nudge ran 1s after a $16.13
// Sam's Club credit imported and 7s before its receipt linked it to the
// purchase, pushing "1 Refund Needs Review" for a refund that never needed
// one. Kept on globalThis (like instrumentation.ts's intervals) since the
// startup poller and a server action can load separate module instances.
const g = globalThis as unknown as { __flowSyncsInFlight?: Set<Promise<unknown>> };
const inFlight = (g.__flowSyncsInFlight ??= new Set());

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
