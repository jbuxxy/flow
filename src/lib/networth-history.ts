import { db } from "@/lib/db";
import { currentDateKey, currentPeriodKey } from "@/lib/period";
import { isDemoHousehold } from "@/lib/demo";

// Upserted (not just inserted) on every /networth load — today's row always
// reflects the latest computed value rather than whatever it happened to be
// on first load that day. Plain arithmetic already computed for the page
// anyway (unlike BillsInsight/MonthlyInsight, no AI/API cost to ration), so
// there's no reason to gate this behind a cache like those do.
export async function recordNetWorthSnapshot(householdId: string, netWorthCents: number): Promise<void> {
  if (await isDemoHousehold(householdId)) return; // frozen — see src/lib/demo.ts
  const dateKey = currentDateKey();
  await db.netWorthSnapshot.upsert({
    where: { householdId_dateKey: { householdId, dateKey } },
    create: { householdId, dateKey, netWorthCents },
    update: { netWorthCents },
  });
}

export type NetWorthTrend = { deltaCents: number; sinceDateKey: string };

// Compares today's net worth against the earliest snapshot recorded *this
// calendar month* — a month-to-date trend that resets every 1st, not a
// rolling "since you last looked" window. For a household with a full
// month of history that reference is the 1st itself (assuming the page
// gets opened that day); for a brand-new household mid-month, the earliest
// snapshot this month is necessarily their very first one ever, so the
// trend naturally reads "since [signup day]" until the month rolls over —
// no separate first-run case needed. Returns null when there's no earlier
// snapshot this month to compare against yet (the household's first day).
export async function getNetWorthTrend(householdId: string, currentNetWorthCents: number): Promise<NetWorthTrend | null> {
  const todayKey = currentDateKey();
  const monthStartKey = `${currentPeriodKey()}-01`;
  const reference = await db.netWorthSnapshot.findFirst({
    where: { householdId, dateKey: { gte: monthStartKey, lt: todayKey } },
    orderBy: { dateKey: "asc" },
  });
  if (!reference) return null;
  return { deltaCents: currentNetWorthCents - reference.netWorthCents, sinceDateKey: reference.dateKey };
}

export type NetWorthMonthlyPoint = { periodKey: string; netWorthCents: number };

// One point per calendar month for the trend chart, folded down from the
// daily snapshot rows recordNetWorthSnapshot writes — the LAST snapshot
// seen for a given month wins, so a completed month shows its true
// month-end value and the current in-progress month shows its latest known
// value. Ascending dateKey order means later same-month rows naturally
// overwrite earlier ones as the Map is built, and Map preserves
// first-insertion order per key, so the result comes out already sorted by
// month.
export async function getNetWorthMonthlyHistory(householdId: string): Promise<NetWorthMonthlyPoint[]> {
  const snapshots = await db.netWorthSnapshot.findMany({
    where: { householdId },
    orderBy: { dateKey: "asc" },
    select: { dateKey: true, netWorthCents: true },
  });

  const byMonth = new Map<string, number>();
  for (const s of snapshots) {
    byMonth.set(s.dateKey.slice(0, 7), s.netWorthCents);
  }

  return Array.from(byMonth, ([periodKey, netWorthCents]) => ({ periodKey, netWorthCents }));
}

export type NetWorthDailyPoint = { dateKey: string; netWorthCents: number };

// Raw daily snapshots, most recent `limit` — the dashboard's glance
// sparkline needs this instead of getNetWorthMonthlyHistory above: that one
// folds to a single point per calendar month, so a household still inside
// its first month of tracking (the common case for weeks after signup) has
// only one monthly point and the sparkline would draw nothing at all. Daily
// granularity shows real movement immediately, well before any household
// has crossed a month boundary.
export async function getNetWorthDailyHistory(householdId: string, limit: number): Promise<NetWorthDailyPoint[]> {
  const snapshots = await db.netWorthSnapshot.findMany({
    where: { householdId },
    orderBy: { dateKey: "desc" },
    take: limit,
    select: { dateKey: true, netWorthCents: true },
  });
  return snapshots.reverse();
}

export type NetWorthWindow = { points: NetWorthDailyPoint[]; deltaCents: number; startKey: string };

// A trailing window of daily snapshots ending in today's LIVE figure — the
// dashboard's Net Worth tile (7 days) and carousel card (30 days) both chart
// this and caption its delta, so the line and the "+/-$X" always describe the
// same span (household report, 2026-09-29: a 30-snapshot chart sat under a
// month-to-date caption). Today's own snapshot row, if any, is replaced by the
// live value. `startKey` is the first real snapshot on/after the requested
// start (snapshots can have gaps), so a caption can name the true start.
// Null when there's no snapshot in the window before today.
export function netWorthWindow(
  daily: NetWorthDailyPoint[],
  fromKey: string,
  todayKey: string,
  liveCents: number,
): NetWorthWindow | null {
  const past = daily.filter((p) => p.dateKey >= fromKey && p.dateKey < todayKey);
  if (past.length === 0) return null;
  return {
    points: [...past, { dateKey: todayKey, netWorthCents: liveCents }],
    deltaCents: liveCents - past[0].netWorthCents,
    startKey: past[0].dateKey,
  };
}
