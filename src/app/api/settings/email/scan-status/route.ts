import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { emailInboxScope, hasFullAccess } from "@/lib/access";
import { isHouseholdScanning } from "@/lib/receipt-sync";
import { ORDER_CHARGE_GRACE_DAYS } from "@/lib/receipt-match";
import type { ReceiptScanStatus } from "@/app/settings/email/actions";

// Lightweight receipt counts for the settings panel to poll while a scan
// runs. A route handler, not a server action: Next runs server actions one
// at a time, so a status poll issued as an action would sit queued behind
// the long scanMyEmailNow it's supposed to be reporting progress on.
export async function GET() {
  const session = await auth();
  if (!session?.user || !hasFullAccess(session.user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const householdId = session.user.householdId;
  // Same inboxes the page shows (emailInboxScope) — every family member's
  // for the owner/a parent, else just this member's own, all aggregated.
  const inboxScope = emailInboxScope(session.user);
  const [conns, parsedCount, latestTxn] = await Promise.all([
    db.emailConnection.findMany({ where: inboxScope, select: { lastPolledAt: true } }),
    // Real receipts only — STALE (junk that cleared the prefilter, non-USD)
    // and DISMISSED don't count as "read".
    db.receipt.count({
      where: { emailConnection: inboxScope, matchState: { notIn: ["STALE", "DISMISSED"] } },
    }),
    db.transaction.aggregate({ where: { householdId }, _max: { occurredOn: true } }),
  ]);
  const lastPolledAt = conns.reduce<Date | null>(
    (latest, c) => (c.lastPolledAt && (!latest || c.lastPolledAt > latest) ? c.lastPolledAt : latest),
    null,
  );

  // Mirror the /settings/email list's own filter (item 1, 2026-08-29): a
  // receipt whose date is ahead of the newest synced transaction has nothing
  // to match yet, so it isn't counted as "awaiting" a human.
  const bankCaughtUpTo = latestTxn._max.occurredOn;
  const graceCutoff = new Date(Date.now() - ORDER_CHARGE_GRACE_DAYS * 86_400_000);
  const awaitingCount = await db.receipt.count({
    where: {
      emailConnection: inboxScope,
      matchState: { in: ["UNMATCHED", "AMBIGUOUS"] },
      totalCents: { not: null },
      // Same filters the page applies: orders only, no shipping notices…
      kind: { not: "SHIPPING" },
      // …and the order-charge grace (inOrderChargeGrace).
      NOT: {
        kind: "ORDER_CONFIRMATION",
        matchState: "UNMATCHED",
        OR: [{ occurredOn: { gt: graceCutoff } }, { occurredOn: null, receivedAt: { gt: graceCutoff } }],
      },
      ...(bankCaughtUpTo
        ? {
            OR: [
              { occurredOn: { lte: bankCaughtUpTo } },
              { occurredOn: null, receivedAt: { lte: bankCaughtUpTo } },
            ],
          }
        : {}),
    },
  });

  const body: ReceiptScanStatus = {
    connected: conns.length > 0,
    scanning: isHouseholdScanning(session.user.householdId),
    parsedCount,
    awaitingCount,
    lastPolledAt: lastPolledAt ? lastPolledAt.toISOString() : null,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
