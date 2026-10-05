import { db } from "@/lib/db";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { daysAgo } from "@/lib/period";
import type { Prisma } from "@prisma/client";

export type UnlabeledP2PTxn = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: Date;
};

// Same idea as UNCATEGORIZED_LOOKBACK_DAYS in buckets.ts: a P2P credit/debit
// nobody labeled after a month isn't worth nagging about forever — it drops
// out of every "unlabeled" surface (dashboard/buckets/income attention
// cards, the /transactions "Unlabeled P2P" filter) rather than being
// tracked as a permanent gap. Still fully visible/reassignable via
// /transactions' other filters, which have no such cutoff.
const P2P_STALE_AFTER_DAYS = 30;

// Shared by the dashboard/buckets/income attention-card counts (via
// getUnlabeledP2PTransfers below) and the /transactions "Unlabeled P2P"
// status filter (transactions/page.tsx), which spreads this straight into
// its own `where` alongside its other query params (account/date/search).
export function unlabeledP2PWhere(householdId: string): Prisma.TransactionWhereInput {
  return {
    householdId,
    patternId: null,
    oneOff: false,
    // A transaction already pointed at a specific tracked Debt is a
    // *confirmed* payment, not an unlabeled one — but every debt payment
    // also carries isTransfer:true and bucketId:null by convention, so
    // without this exclusion any P2P-named debt's payments (PayPal Credit,
    // paid via bare "PayPal") matched the OR clause below forever and
    // never dropped out of this queue (real report: a PayPal Credit
    // payment kept showing as "unlabeled" a month after being confirmed).
    debtId: null,
    occurredOn: { gte: daysAgo(P2P_STALE_AFTER_DAYS) },
    AND: [
      { OR: [{ bucketId: null }, { isTransfer: true }, { isIncome: true }] },
      { OR: P2P_DISCOVERY_KEYWORDS.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) },
    ],
  };
}

// Direction-scoped count/list for attention cards — /income (CREDIT only —
// money in) and the dashboard/buckets cards (both directions).
export async function getUnlabeledP2PTransfers(
  householdId: string,
  direction?: "CREDIT" | "DEBIT",
): Promise<UnlabeledP2PTxn[]> {
  return db.transaction.findMany({
    where: {
      ...unlabeledP2PWhere(householdId),
      ...(direction === "DEBIT" ? { amountCents: { gt: 0 } } : direction === "CREDIT" ? { amountCents: { lt: 0 } } : {}),
    },
    orderBy: { occurredOn: "desc" },
    take: 60,
    select: { id: true, merchant: true, amountCents: true, occurredOn: true },
  });
}

function unlabeledP2PDismissKind(direction: "CREDIT" | "DEBIT"): string {
  return direction === "DEBIT" ? "UNLABELED_P2P_DEBIT" : "UNLABELED_P2P_CREDIT";
}

// Direction-scoped attention card counterpart to a dismiss: not "stop
// telling me forever," just "I've seen this batch" — the card comes back
// the moment a transaction newer than the dismissal shows up unlabeled in
// this direction, same idea as getActiveInsufficientMinimumDebts' per-cycle
// redisplay, just anchored to "any new one" instead of a billing cycle.
export async function getActiveUnlabeledP2PTransfers(
  householdId: string,
  direction: "CREDIT" | "DEBIT",
): Promise<UnlabeledP2PTxn[]> {
  const txns = await getUnlabeledP2PTransfers(householdId, direction);
  if (txns.length === 0) return [];
  const dismissal = await db.suggestionDismissal.findUnique({
    where: { householdId_kind_key: { householdId, kind: unlabeledP2PDismissKind(direction), key: "all" } },
  });
  // txns is occurredOn-desc, so [0] is the most recent unlabeled one.
  if (dismissal && txns[0].occurredOn <= dismissal.createdAt) return [];
  return txns;
}

export async function dismissUnlabeledP2P(householdId: string, direction: "CREDIT" | "DEBIT"): Promise<void> {
  const kind = unlabeledP2PDismissKind(direction);
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind, key: "all" } },
    create: { householdId, kind, key: "all" },
    update: { createdAt: new Date() },
  });
}

// The dashboard shows one combined card for both directions (unlike
// /buckets and /income, which only ever care about their own), so
// dismissing it there dismisses both — otherwise it'd immediately
// reappear from whichever direction's dismissal it didn't cover.
export async function dismissUnlabeledP2PBoth(householdId: string): Promise<void> {
  await Promise.all([dismissUnlabeledP2P(householdId, "DEBIT"), dismissUnlabeledP2P(householdId, "CREDIT")]);
}
