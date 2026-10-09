// Once-per-period work (a bucket alert, the weekly digest, the month
// rollover) guarded by a unique "already done" row. Every such site follows
// the same rules:
//   - claim with createMany({ skipDuplicates: true }) — ON CONFLICT DO
//     NOTHING, so a repeat run doesn't make Postgres log a unique-violation
//     ERROR (it used to, ~100 a day, with create-and-catch);
//   - a claim that fails for any other reason is logged, never read as
//     "already done";
//   - if the work after a successful claim throws, the claim is released so
//     the next run retries — a claim written before a failed push or report
//     used to skip that period's notification for good (2026-10-08 review);
//   - never throws: several callers (simplefin-sync's bucket alerts) run
//     inside a larger job that a notification failure mustn't abort.
export type RunOnceResult = "done" | "already-done" | "failed";

export async function runOnce(
  label: string,
  claim: () => Promise<{ count: number }>,
  release: () => Promise<unknown>,
  work: () => Promise<void>,
): Promise<RunOnceResult> {
  let count: number;
  try {
    ({ count } = await claim());
  } catch (err) {
    console.error(`[run-once] ${label}: claim failed:`, err);
    return "failed";
  }
  if (count === 0) return "already-done";

  try {
    await work();
    return "done";
  } catch (err) {
    console.error(`[run-once] ${label}: failed, releasing the claim to retry next run:`, err);
    try {
      await release();
    } catch (releaseErr) {
      console.error(`[run-once] ${label}: releasing the claim failed too:`, releaseErr);
    }
    return "failed";
  }
}
