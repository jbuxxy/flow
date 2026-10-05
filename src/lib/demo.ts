import { db } from "@/lib/db";

// The read-only public "example household" (Household.isDemo, seeded by
// src/scripts/seed-demo.ts). Mutating server actions are already blocked at
// the proxy for a demo session (src/lib/auth.config.ts's authorized()); this
// helper is for the OTHER write path — helpers that write or call the AI
// provider during a plain GET render (snapshots, report/budget-plan
// create-on-read, bucket-icon backfill, asset re-estimates). Each of those
// early-returns its cached/no-op result when this is true, so the demo stays
// frozen on whatever the one-time seed pass generated.
//
// Small per-request cost (one indexed lookup); callers already do several
// queries per render. Not memoized on purpose — a stale cache flipping the
// wrong way would either un-freeze the demo or freeze a real household.
export async function isDemoHousehold(householdId: string): Promise<boolean> {
  const h = await db.household.findUnique({
    where: { id: householdId },
    select: { isDemo: true },
  });
  return h?.isDemo === true;
}
