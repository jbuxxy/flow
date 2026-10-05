import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentPeriodKey } from "@/lib/period";
import { getBucketsWithProgress } from "@/lib/buckets";
import { getAdHocIncomeThisMonth } from "@/lib/income";
import { countedIncomeCents, offsetSumByCreditId } from "@/lib/reimbursements";
import { sendPushToBucketForType } from "@/lib/push";
import { formatCents } from "@/lib/money";

// Household setting: Household.autoApplyAdHocIncomeToBuckets (see its own
// schema comment for the full mechanism this file implements) — off by
// default, household request 2026-09-12.

export type TopUpSourceEntry = { id: string; remainingCents: number };
export type TopUpTargetBucket = { id: string; overageCents: number };
export type TopUpDraw = { bucketId: string; sourceEntryId: string; amountCents: number };

// Pure allocation — no `db`, directly unit-testable (test/lib/bucket-ad-hoc-topup.test.ts).
// Greedy: walks target buckets in the order given (the household's own
// bucket sortOrder — whichever they've ranked first gets first claim on the
// pool each run) and, for each, draws from source entries in the order
// given (oldest ad hoc income first) until either that bucket's overage is
// fully covered or the pool runs dry. A single source entry can fund more
// than one bucket, and a single bucket's overage can be split across more
// than one source entry — neither list is mutated.
export function allocateAdHocSurplus(
  sourceEntries: TopUpSourceEntry[],
  targetBuckets: TopUpTargetBucket[],
): TopUpDraw[] {
  const entries = sourceEntries.map((e) => ({ ...e }));
  const draws: TopUpDraw[] = [];
  for (const bucket of targetBuckets) {
    let need = bucket.overageCents;
    if (need <= 0) continue;
    for (const entry of entries) {
      if (need <= 0) break;
      if (entry.remainingCents <= 0) continue;
      const amountCents = Math.min(need, entry.remainingCents);
      draws.push({ bucketId: bucket.id, sourceEntryId: entry.id, amountCents });
      entry.remainingCents -= amountCents;
      need -= amountCents;
    }
  }
  return draws;
}

export type TopUpRow = { id: string; sourceTransactionId: string; amountCents: number; createdAt: Date };

// Pure — given every top-up row and how much each source credit *still* counts
// as ad hoc income, returns the deletes/updates that bring each source's total
// draws back down to that figure. Newest draws are revoked first (the oldest
// dollars were the first spoken for). A source missing from the map counts 0.
export function trimTopUpsToCounted(
  rows: TopUpRow[],
  countedBySource: Map<string, number>,
): { deleteIds: string[]; updates: { id: string; amountCents: number }[] } {
  const bySource = new Map<string, TopUpRow[]>();
  for (const r of rows) {
    const list = bySource.get(r.sourceTransactionId);
    if (list) list.push(r);
    else bySource.set(r.sourceTransactionId, [r]);
  }
  const deleteIds: string[] = [];
  const updates: { id: string; amountCents: number }[] = [];
  for (const [sourceId, list] of bySource) {
    let excess = list.reduce((s, r) => s + r.amountCents, 0) - (countedBySource.get(sourceId) ?? 0);
    if (excess <= 0) continue;
    const newestFirst = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    for (const r of newestFirst) {
      if (excess <= 0) break;
      if (r.amountCents <= excess) {
        deleteIds.push(r.id);
        excess -= r.amountCents;
      } else {
        updates.push({ id: r.id, amountCents: r.amountCents - excess });
        excess = 0;
      }
    }
  }
  return { deleteIds, updates };
}

// A top-up is only ever funded by a credit that counts as ad hoc income
// (isIncome, not a tracked Income, minus any TransactionOffset). When that
// stops being true — the credit gets linked as a reimbursement, or carved off
// against a debt payment, in whole or part (2026-09-19: a $177 Mobile Deposit
// offset against a payment left $177 of Dining/Retail top-ups standing, so
// /buckets read "over income") — the draws against it are revoked here so the
// buckets' effective caps fall back automatically. Independent of the
// household setting on purpose: turning auto-apply off must not strand caps
// it already raised against money that no longer exists. Run from the link
// actions (immediate) and every sync (self-healing, covers any other path
// that flips a credit's income status). Returns the rows changed.
export async function reconcileAdHocTopUps(householdId: string): Promise<number> {
  const rows = await db.bucketAdHocTopUp.findMany({
    where: { householdId },
    select: {
      id: true,
      sourceTransactionId: true,
      amountCents: true,
      createdAt: true,
      sourceTransaction: { select: { amountCents: true, isIncome: true, incomeId: true } },
    },
  });
  if (rows.length === 0) return 0;

  const sourceIds = [...new Set(rows.map((r) => r.sourceTransactionId))];
  const offsetSums = await offsetSumByCreditId(sourceIds);
  const counted = new Map<string, number>();
  for (const r of rows) {
    const src = r.sourceTransaction;
    const stillAdHoc = src.isIncome && src.incomeId === null;
    counted.set(
      r.sourceTransactionId,
      stillAdHoc ? countedIncomeCents(Math.abs(src.amountCents), offsetSums.get(r.sourceTransactionId) ?? 0) : 0,
    );
  }

  const { deleteIds, updates } = trimTopUpsToCounted(rows, counted);
  if (deleteIds.length === 0 && updates.length === 0) return 0;
  await db.$transaction([
    ...(deleteIds.length > 0 ? [db.bucketAdHocTopUp.deleteMany({ where: { id: { in: deleteIds } } })] : []),
    ...updates.map((u) => db.bucketAdHocTopUp.update({ where: { id: u.id }, data: { amountCents: u.amountCents } })),
  ]);
  return deleteIds.length + updates.length;
}

// Run once per household per sync (simplefin-sync.ts), alongside the other
// household-wide passes — draws from this month's still-unallocated ad hoc/
// P2P income (never a tracked recurring paycheck, so a biweekly earner's
// 3rd-paycheck month never funds this) and applies it to whichever
// bucket(s) have actually gone over their cap this period, in the
// household's own bucket priority order (sortOrder). A bucket only ever
// qualifies once it's genuinely over — never on an early-month pace
// projection, so this can't front-load found money into a bucket on the
// 1st just because a single early purchase makes it look fast; it only
// ever moves once a bucket has actually "bulged" past its cap.
export async function autoApplyAdHocIncomeToBuckets(householdId: string): Promise<void> {
  // Before the setting check — see reconcileAdHocTopUps.
  await reconcileAdHocTopUps(householdId);
  const household = await db.household.findUnique({
    where: { id: householdId },
    select: { autoApplyAdHocIncomeToBuckets: true },
  });
  if (!household?.autoApplyAdHocIncomeToBuckets) return;

  const periodKey = currentPeriodKey();
  const adHoc = await getAdHocIncomeThisMonth(householdId);
  if (adHoc.entries.length === 0) return;

  const [progress, buckets] = await Promise.all([
    getBucketsWithProgress(householdId), // already folds in prior top-ups this period
    db.bucket.findMany({ where: { householdId }, select: { id: true, name: true, sortOrder: true } }),
  ]);
  const sortOrderById = new Map(buckets.map((b) => [b.id, b.sortOrder]));
  const nameById = new Map(buckets.map((b) => [b.id, b.name]));

  // excludedFromAllocation (a one-time-purchase bucket) tracks a lifetime
  // target, not a monthly cap — this mechanism is inherently monthly
  // (periodKey-scoped), so it doesn't apply there.
  const targets: TopUpTargetBucket[] = progress
    .filter((p) => p.remainingCents < 0 && !p.excludedFromAllocation)
    .sort((a, b) => (sortOrderById.get(a.id) ?? 0) - (sortOrderById.get(b.id) ?? 0))
    .map((p) => ({ id: p.id, overageCents: -p.remainingCents }));
  if (targets.length === 0) return;

  // The "how much of this month's income is still unspoken for, and what do
  // we draw against it" step is read-then-write against a shared, limited
  // pool (this period's ad hoc income) — done inside one Serializable
  // transaction so two overlapping syncHousehold runs for the same
  // household (a manual "Sync Now" racing the scheduled poll) can't both
  // read the same not-yet-drawn income and both write a draw against it.
  // Postgres aborts the loser with a serialization failure instead of
  // silently double-allocating the same dollars (real finding, 2026-09-12
  // code review). Losing that race is a harmless no-op here — every field
  // above is re-derived from scratch every sync, so the very next run picks
  // up exactly where the aborted one left off; nothing needs to be retried
  // inline.
  let draws: TopUpDraw[] = [];
  try {
    draws = await db.$transaction(
      async (tx) => {
        const alreadyDrawn = await tx.bucketAdHocTopUp.groupBy({
          by: ["sourceTransactionId"],
          where: { householdId, periodKey },
          _sum: { amountCents: true },
        });
        const drawnBySource = new Map(alreadyDrawn.map((r) => [r.sourceTransactionId, r._sum.amountCents ?? 0]));

        // Oldest first — the same "spend the earliest dollar first"
        // convention this app already uses for reconciling other running pools.
        const sourceEntries: TopUpSourceEntry[] = [...adHoc.entries]
          .sort((a, b) => a.occurredOn.getTime() - b.occurredOn.getTime())
          .map((e) => ({ id: e.id, remainingCents: e.amountCents - (drawnBySource.get(e.id) ?? 0) }))
          .filter((e) => e.remainingCents > 0);
        if (sourceEntries.length === 0) return []; // this month's ad hoc income is already fully spoken for

        const computedDraws = allocateAdHocSurplus(sourceEntries, targets);
        if (computedDraws.length === 0) return [];

        await tx.bucketAdHocTopUp.createMany({
          data: computedDraws.map((d) => ({
            householdId,
            bucketId: d.bucketId,
            sourceTransactionId: d.sourceEntryId,
            periodKey,
            amountCents: d.amountCents,
          })),
        });
        return computedDraws;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (err) {
    // P2034 is Prisma's own code for exactly this — a Serializable
    // transaction losing a real write conflict — the expected, benign
    // shape when a manual "Sync Now" overlaps the scheduled poll for the
    // same household. Anything else (a constraint violation from a bad
    // allocateAdHocSurplus draw, a transient connection error, a future
    // schema change) is a real bug and must not be silently relabeled as
    // "another sync already applied this" and discarded (real finding,
    // 2026-09-14 code review).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
      console.error(
        `[bucket-ad-hoc-topup] serialization conflict for household ${householdId} — another sync already applied this period's draws, skipping:`,
        err,
      );
      return;
    }
    throw err;
  }
  if (draws.length === 0) return;

  const totalByBucket = new Map<string, number>();
  for (const d of draws) totalByBucket.set(d.bucketId, (totalByBucket.get(d.bucketId) ?? 0) + d.amountCents);
  // Independent per-bucket pushes — no shared state between them, so no
  // reason to send them one at a time (2026-09-14 code review).
  await Promise.all(
    [...totalByBucket].map(([bucketId, cents]) =>
      sendPushToBucketForType(bucketId, householdId, "BUCKET_TOPPED_UP", {
        title: `${nameById.get(bucketId) ?? "A Bucket"} Covered From Extra Income`,
        body: `${formatCents(cents)} of this month's ad hoc income was applied to keep it from going over its cap.`,
        url: `/buckets/${bucketId}`,
      }),
    ),
  );
}
