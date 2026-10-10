// The email-receipt pipeline, called from syncHousehold (src/lib/simplefin-sync.ts)
// right before categorizeUncategorizedTransactions:
//
//   pollHouseholdEmails      — fetch + prefilter + AI-parse each member's inbox
//   matchReceipts            — link parsed receipts to household transactions
//   matchBillNoticeAmounts   — link parsed bill notices to bills/debts, flag drift
//                              (see src/lib/bill-notice-sync.ts)
//   purgeStaleReceipts       — drop the transient bookkeeping once it's spent
//   purgeStaleBillNotices    — same, for bill notices (bill-notice-sync.ts)
//
// Same conventions as the rest of sync: never throw out of the poll path (a
// broken mailbox must not stop the bank sync), match conservatively (an
// ambiguous receipt is left for a human, never guessed), and self-heal
// (an unmatched receipt is retried every sync until it matches or ages out).
// pollHouseholdEmails does double duty: one IMAP fetch + AI batch call feeds
// both the receipt pipeline (this file) and the bill-notice pipeline
// (bill-notice-sync.ts) — see processBatch below.

import { Prisma, type Receipt } from "@prisma/client";
import { db } from "@/lib/db";
import {
  getEmailConnections,
  recordEmailHealth,
  openMailbox,
  RECEIPT_BATCH_LIMIT,
  type EmailConnectionRow,
  type RawEmail,
} from "@/lib/email-provider";
import { looksLikeReceipt, looksLikeBillNotice } from "@/lib/receipt-parse";
import {
  receiptChargeScopeWhere,
  receiptAmountWhere,
  receiptMatchWindow,
  plausibleReceiptCharge,
  aliasKey,
  isP2PReceipt,
  RECEIPT_WIDE_MATCH_AFTER_DAYS,
  refundItemsMatch,
} from "@/lib/receipt-match";
import { bnplPlanMatchesReceipt } from "@/lib/bnpl-plan-match";
import { currentWeekKey, daysAgo } from "@/lib/period";
import { extractReceipts, type ParsedReceipt, type ParsedReceiptLineItem } from "@/lib/ai";
import { matchBillNoticeAmounts, purgeStaleBillNotices } from "@/lib/bill-notice-sync";

const FIRST_POLL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const UNMATCHED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Manual "scan now"

// In-memory "a full manual scan is running for this household" flag (single
// container — see src/instrumentation.ts). Lets the settings panel keep
// polling for progress after the fire-and-forget kickoff returns, without a
// schema column for transient state.
const scanningHouseholds = new Set<string>();

export function isHouseholdScanning(householdId: string): boolean {
  return scanningHouseholds.has(householdId);
}

// The manual counterpart to the three steps syncHousehold runs, plus a
// re-categorization pass so a freshly-resolved party takes effect right
// away. Runs fire-and-forget (see scanMyEmailNow) — draining a 90-day
// backlog + AI extraction runs for minutes, past any proxy timeout.
const MAX_MANUAL_SCAN_ITERATIONS = 25; // 25 * MANUAL_SCAN_BATCHES batches

export async function runFullScan(householdId: string): Promise<void> {
  if (scanningHouseholds.has(householdId)) return;
  scanningHouseholds.add(householdId);
  try {
    // Drain to completion (newest-first), matching as we go so the settings
    // panel's live count and the enriched transactions update progressively
    // rather than all at the end.
    for (let i = 0; i < MAX_MANUAL_SCAN_ITERATIONS; i++) {
      const { more } = await pollHouseholdEmails(householdId, { maxBatches: 8 });
      await matchReceipts(householdId);
      await matchBillNoticeAmounts(householdId);
      if (!more) break;
    }
    await purgeStaleReceipts(householdId);
    await purgeStaleBillNotices(householdId);
    const { categorizeUncategorizedTransactions } = await import("@/lib/simplefin-sync");
    await categorizeUncategorizedTransactions(householdId);
  } catch (err) {
    console.error(`[receipt-sync] manual scan failed for household ${householdId}:`, err);
  } finally {
    scanningHouseholds.delete(householdId);
  }
}

// ---------------------------------------------------------------------------
// Poll — newest-first, 90-day-bounded, two cursors (see EmailConnection).
//
//   lastSeenUid     — steady state: each poll processes `uid > lastSeenUid`
//                     (genuinely new mail) and advances it.
//   oldestPolledUid — one-time backfill: each poll also walks
//                     `uid < oldestPolledUid` within 90 days, newest-first,
//                     lowering it until it hits the 90-day floor (<= 1).

export async function pollHouseholdEmails(
  householdId: string,
  opts: { maxBatches?: number } = {},
): Promise<{ more: boolean }> {
  // `maxBatches` bounds fetch+parse rounds per connection per call: a few
  // for the routine 20-minute sync, more for a manual "Scan Now" (which
  // also loops runFullScan until `more` is false).
  const maxBatches = Math.max(1, opts.maxBatches ?? 3);
  const connections = await getEmailConnections(householdId);
  if (connections.length === 0) return { more: false };

  let more = false;
  for (const conn of connections) {
    try {
      if (await pollConnection(householdId, conn, maxBatches)) more = true;
      await recordEmailHealth(conn.id, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[receipt-sync] poll failed for connection ${conn.id}:`, message);
      await recordEmailHealth(conn.id, message);
    }
  }
  return { more };
}

// Returns whether more work remains (unfinished backfill, or another page
// of new mail).
async function pollConnection(
  householdId: string,
  conn: EmailConnectionRow,
  maxBatches: number,
): Promise<boolean> {
  const sinceDate = new Date(Date.now() - FIRST_POLL_LOOKBACK_MS);
  const limit = RECEIPT_BATCH_LIMIT;

  let lastSeenUid = conn.lastSeenUid;
  let oldestPolledUid = conn.oldestPolledUid;
  let batches = 0;
  let more = false;

  const mb = await openMailbox(conn.config);
  try {
    // Bootstrap: establish the ceiling from the newest message in the 90-day
    // window without processing anything yet — the backfill below then walks
    // down from there, newest-first.
    if (lastSeenUid == null) {
      const probe = await mb.fetchWindow({ sinceDate, limit: 1 });
      if (probe.messages.length === 0) {
        await db.emailConnection.update({
          where: { id: conn.id },
          data: { lastSeenUid: 0, oldestPolledUid: 1, lastPolledAt: new Date() },
        });
        return false;
      }
      lastSeenUid = probe.messages[0].uid;
      oldestPolledUid = lastSeenUid + 1; // backfill starts just above the ceiling
    }
    if (oldestPolledUid == null) oldestPolledUid = lastSeenUid + 1;

    // Phase 1 — forward gap (uid > lastSeenUid), OLDEST-first so a
    // forward-only cursor never skips the middle of a large gap (e.g. the
    // app was offline for days). Steady state this is 0-1 tiny pages.
    while (batches < maxBatches) {
      const { messages, totalMatched } = await mb.fetchWindow({
        sinceDate,
        newerThanUid: lastSeenUid,
        limit,
        order: "asc",
      });
      if (messages.length === 0) break;
      batches++;
      const { unresolvedUids } = await processBatch(householdId, conn.id, messages);
      if (unresolvedUids.length > 0) {
        // Transient AI failure — don't advance past the first still-unparsed
        // message; the next sync retries from there.
        lastSeenUid = Math.max(lastSeenUid, Math.min(...unresolvedUids) - 1);
        more = true;
        break;
      }
      lastSeenUid = Math.max(...messages.map((m) => m.uid));
      if (totalMatched <= limit) break;
      more = true; // another page of the gap remains
    }

    // Phase 2 — backfill (uid < oldestPolledUid, within 90 days), newest-first.
    while (oldestPolledUid > 1 && batches < maxBatches) {
      const { messages, totalMatched } = await mb.fetchWindow({
        sinceDate,
        olderThanUid: oldestPolledUid,
        limit,
      });
      if (messages.length === 0) {
        oldestPolledUid = 1; // nothing older within 90 days — backfill complete
        break;
      }
      batches++;
      const { unresolvedUids } = await processBatch(householdId, conn.id, messages);
      const pageMin = messages[messages.length - 1].uid; // newest-first, so last is oldest
      if (unresolvedUids.length > 0) {
        // Hold above the highest still-unparsed message so the next pass
        // retries it (already-parsed ones above are cheap to re-fetch — they
        // dedupe on messageId). Don't spin: only "more" if we can still
        // descend past the hold.
        const hold = Math.max(...unresolvedUids) + 1;
        more = hold < oldestPolledUid;
        oldestPolledUid = Math.min(oldestPolledUid, hold);
      } else {
        oldestPolledUid = pageMin;
        if (totalMatched <= limit) oldestPolledUid = 1; // that was the last page
        if (oldestPolledUid > 1) more = true;
      }
    }
  } finally {
    await mb.close();
  }

  await db.emailConnection.update({
    where: { id: conn.id },
    data: { lastSeenUid, oldestPolledUid, lastPolledAt: new Date() },
  });
  return more || oldestPolledUid > 1;
}

// Dedupe (by messageId), prefilter, AI-extract and upsert one page of
// fetched mail. Returns the UIDs the AI gave no result for (transient
// outage / omission) so the caller can hold its cursor and retry them.
async function processBatch(
  householdId: string,
  connectionId: string,
  messages: RawEmail[],
): Promise<{ unresolvedUids: number[] }> {
  // A re-fetched message we've already resolved (MATCHED / AMBIGUOUS /
  // DISMISSED / STALE) must never be reopened or re-sent to the AI.
  const seen = new Set(
    (
      await db.receipt.findMany({
        where: { emailConnectionId: connectionId, messageId: { in: messages.map((m) => m.messageId) } },
        select: { messageId: true },
      })
    ).map((r) => r.messageId),
  );

  const candidates = messages.filter((m) => !seen.has(m.messageId) && (looksLikeReceipt(m) || looksLikeBillNotice(m)));
  if (candidates.length === 0) return { unresolvedUids: [] };

  const parsed = await extractReceipts(householdId, candidates);
  const unresolvedUids: number[] = [];
  for (const msg of candidates) {
    const p = parsed.get(msg.messageId);
    if (!p) {
      unresolvedUids.push(msg.uid);
      continue;
    }
    const usable = p.isReceipt && (!p.currency || p.currency === "USD");
    await db.receipt.upsert({
      where: { emailConnectionId_messageId: { emailConnectionId: connectionId, messageId: msg.messageId } },
      create: {
        householdId,
        emailConnectionId: connectionId,
        messageId: msg.messageId,
        receivedAt: msg.receivedAt,
        ...receiptDataFrom(p, usable ? "UNMATCHED" : "STALE", msg.receivedAt),
      },
      update: receiptDataFrom(p, usable ? "UNMATCHED" : "STALE", msg.receivedAt),
    });
    if (p.billNotice) {
      await db.billNoticeEmail.upsert({
        where: { emailConnectionId_messageId: { emailConnectionId: connectionId, messageId: msg.messageId } },
        create: {
          householdId,
          emailConnectionId: connectionId,
          messageId: msg.messageId,
          receivedAt: msg.receivedAt,
          billerName: p.billNotice.billerName,
          amountDueCents: p.billNotice.amountDueCents,
          dueDate: p.billNotice.dueDate,
          accountLast4: p.billNotice.accountLast4,
        },
        update: {},
      });
    }
  }
  return { unresolvedUids };
}

// Truncate a DateTime to a UTC calendar day (for the @db.Date `occurredOn`).
function toUTCDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function receiptDataFrom(
  p: ParsedReceipt | undefined,
  matchState: "UNMATCHED" | "STALE",
  receivedAt: Date,
): Omit<Prisma.ReceiptUncheckedCreateInput, "householdId" | "emailConnectionId" | "messageId" | "receivedAt"> {
  return {
    kind: p?.kind ?? "OTHER",
    party: p?.party ?? null,
    partyIsPerson: p?.partyIsPerson ?? false,
    p2pApp: p?.p2pApp ?? null,
    totalCents: p?.totalCents ?? null,
    // The email body didn't state a date — fall back to when the email
    // arrived. A receipt email lands within a day of the purchase, so this
    // is a good anchor for the match window and means the linker
    // card never shows a bare "no date". (Item 5, 2026-08-29.)
    occurredOn: p?.occurredOn ?? toUTCDate(receivedAt),
    orderNumber: p?.orderNumber ?? null,
    noteText: p?.noteText ?? null,
    isRefund: p?.isRefund ?? false,
    refundTo: p?.refundTo ?? null,
    refundToLast4: p?.refundToLast4 ?? null,
    lineItems: p && p.lineItems.length > 0 ? toJson(p.lineItems) : Prisma.JsonNull,
    matchState,
  };
}

// ---------------------------------------------------------------------------
// Match

export async function matchReceipts(householdId: string): Promise<void> {
  const receipts = await db.receipt.findMany({
    where: {
      householdId,
      matchState: { in: ["UNMATCHED", "AMBIGUOUS"] },
      totalCents: { not: null },
    },
  });
  for (const receipt of receipts) {
    await matchOneReceipt(householdId, receipt);
  }
  await retryRefundPurchaseLinks(householdId);
}

async function setAmbiguous(receipt: Receipt): Promise<void> {
  if (receipt.matchState !== "AMBIGUOUS") {
    await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "AMBIGUOUS" } });
  }
}

// The same order email routinely lands in two mailboxes (both spouses are on
// the account) — two Receipt rows, since the dedup key is
// (emailConnectionId, messageId). Once one of a duplicate set is placed, or
// simply as the older of the set, retire the rest as STALE so they don't
// each nag in the linker and compete for the same charge in the picker
// (the "I picked a charge and it just made the row vanish" report,
// 2026-08-30 — that was linkReceiptToTransaction hitting an
// already-has-a-receipt charge). Keyed on order number when both carry one,
// else party + total + date for a business (never a person — a friend can
// legitimately Venmo you the same amount on the same day twice).
async function retireIfDuplicate(householdId: string, receipt: Receipt): Promise<boolean> {
  // The total is always part of the key — a recurring subscription bills the
  // same order/subscription id twice at different amounts (a proration and a
  // full month), and those are two receipts, not a dup: Google AI Plus at
  // $9.64 and $10.71 both parsed order "SOP.3373-…-58618..8" and the
  // order-number-only key retired the $10.71 one. (2026-08-31.)
  if (receipt.totalCents == null) return false;
  const key: Prisma.ReceiptWhereInput | null =
    receipt.orderNumber && receipt.orderNumber.length >= 4
      ? { orderNumber: receipt.orderNumber, totalCents: receipt.totalCents }
      : receipt.party && !receipt.partyIsPerson
        ? { party: receipt.party, totalCents: receipt.totalCents, occurredOn: receipt.occurredOn }
        : null;
  if (!key) return false;

  const twins = await db.receipt.findMany({
    where: {
      householdId,
      id: { not: receipt.id },
      matchState: { in: ["UNMATCHED", "AMBIGUOUS", "MATCHED", "MATCHED_TO_PLAN"] },
      ...key,
    },
    select: { id: true, matchState: true, createdAt: true },
  });
  const placed = new Set(["MATCHED", "MATCHED_TO_PLAN"]);
  const superseded = twins.some(
    (t) =>
      placed.has(t.matchState) ||
      t.createdAt < receipt.createdAt ||
      (t.createdAt.getTime() === receipt.createdAt.getTime() && t.id < receipt.id),
  );
  if (!superseded) return false;
  await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "STALE" } });
  return true;
}

async function matchOneReceipt(householdId: string, receipt: Receipt): Promise<void> {
  const total = receipt.totalCents;
  if (total == null) return;

  // A $0 "receipt" is a plan-change / free-trial / appointment confirmation
  // (Google One tier switch, a $0 tire-rotation booking) — nothing to match,
  // and it just nags forever. Retire it.
  if (total <= 0) {
    if (receipt.matchState !== "STALE") {
      await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "STALE" } });
    }
    return;
  }

  if (await retireIfDuplicate(householdId, receipt)) return;
  if (await tryTransactionMatch(householdId, receipt, total)) return;

  // tryTransactionMatch left it unplaced. If an earlier run had parked it
  // AMBIGUOUS but this run's candidates no longer qualify (a decoy got
  // linked elsewhere, or the sign/scope rules tightened), downgrade to
  // UNMATCHED so it stops nagging the review card while it waits.
  if (receipt.matchState === "AMBIGUOUS") {
    await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "UNMATCHED" } });
  }

  // No bank transaction placed it. A BNPL purchase (Affirm/Klarna/Afterpay/
  // …) never posts as a single charge — the bank only sees the installments
  // — so try attaching the receipt to a tracked installment plan instead.
  await matchReceiptToBnplPlan(householdId, receipt, total);
}

// Returns true when the receipt was placed on a transaction, or
// deliberately parked (AMBIGUOUS for a human / STALE as a dup) — false when
// it's still UNMATCHED and worth trying a BNPL plan / a later sync.
async function tryTransactionMatch(
  householdId: string,
  receipt: Receipt,
  total: number,
): Promise<boolean> {
  const anchor = receipt.occurredOn ?? receipt.receivedAt;
  // A refund credit routinely posts 3–10 business days after its email, so
  // a refund receipt searches the wide window from the start.
  const { from, to } = receipt.isRefund
    ? receiptMatchWindow(anchor, RECEIPT_WIDE_MATCH_AFTER_DAYS)
    : receiptMatchWindow(anchor);
  const accountScope = await refundAccountScope(householdId, receipt);

  // "Is this total distinctive in the window?" — counts BOTH signs
  // regardless of receiptAmountWhere's debit-only gate, since a same-amount
  // refund still means the amount isn't unique enough to trust an opaque
  // descriptor on.
  const countAtAmount = (lo: Date, hi: Date) =>
    db.transaction.count({
      where: {
        householdId,
        occurredOn: { gte: lo, lte: hi },
        OR: [{ amountCents: total }, { amountCents: -total }],
      },
    });

  const amountCandidates = await db.transaction.findMany({
    where: {
      householdId,
      receipt: { is: null },
      occurredOn: { gte: from, lte: to },
      AND: [
        receiptAmountWhere(receipt, total),
        // A P2P receipt only ever matches a P2P-looking charge, and a
        // non-P2P receipt never does (item 3/4, 2026-08-29).
        receiptChargeScopeWhere(receipt),
        accountScope,
      ],
    },
    select: { id: true, merchant: true, rawDescription: true, amountCents: true },
  });

  // Bank-merchant strings the household has manually linked this receipt's
  // party to before (Classifieds.com → "Mountain Digital Media") — treated as
  // name-plausible below.
  const aliasMerchants = receipt.party
    ? new Set(
        (
          await db.receiptMerchantAlias.findMany({
            where: { householdId, receiptParty: aliasKey(receipt.party) },
            select: { merchantText: true },
          })
        ).map((a) => a.merchantText),
      )
    : undefined;

  if (amountCandidates.length > 0) {
    // plausibleReceiptCharge is `true` for a P2P / party-less receipt, so
    // for those `plausible` === `amountCandidates` and this behaves exactly
    // as the old bare length check did. For a non-P2P receipt with a known
    // party, only a name-resembling charge counts as an auto-link
    // candidate — this is what stops a $9.64 "Google Play" receipt latching
    // onto the lone same-amount Amazon charge once the sign gate has
    // filtered out the real (refund) decoy. (2026-08-30)
    const plausible = amountCandidates.filter((c) => plausibleReceiptCharge(receipt, c, aliasMerchants));
    if (plausible.length === 1) {
      await linkReceipt(receipt, plausible[0].id);
      return true;
    }
    if (plausible.length === 0 && amountCandidates.length === 1) {
      // One same-amount in-scope charge whose descriptor resembles nothing —
      // an opaque "CHECK 1052" for a slow bill-pay. Trust it only when the
      // total is genuinely distinctive in the window (either sign); else
      // leave it UNMATCHED and keep retrying rather than guess.
      if ((await countAtAmount(from, to)) === 1) {
        await linkReceipt(receipt, amountCandidates[0].id);
        return true;
      }
      return false;
    }
    // 2+ candidates, or 2+ that resemble the payee — a human disambiguates.
    await setAmbiguous(receipt);
    return true;
  }

  // No free transaction at this amount. If one at this amount/date already
  // carries a receipt, this is the same charge seen from a second mailbox
  // (both spouses got the order email) — retire it rather than leave it
  // nagging in the "awaiting" list.
  const alreadyCovered = await db.transaction.findFirst({
    where: {
      householdId,
      receipt: { isNot: null },
      occurredOn: { gte: from, lte: to },
      AND: [receiptAmountWhere(receipt, total)],
    },
    select: { id: true },
  });
  if (alreadyCovered) {
    await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "STALE" } });
    return true;
  }

  // Amazon and similar: the order total rarely equals the settled per-
  // shipment charge, so fall back to the order number turning up in the
  // bank descriptor. Distinctive enough to trust on an exact single hit.
  if (receipt.orderNumber && receipt.orderNumber.length >= 6) {
    const byOrderNumber = await db.transaction.findMany({
      where: {
        householdId,
        receipt: { is: null },
        occurredOn: { gte: from, lte: to },
        OR: [
          { rawDescription: { contains: receipt.orderNumber, mode: "insensitive" } },
          { notes: { contains: receipt.orderNumber, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (byOrderNumber.length === 1) {
      await linkReceipt(receipt, byOrderNumber[0].id);
      return true;
    }
  }

  // Wider-window fallback for a charge that posts 5–14 days after its receipt
  // email — a mailed check / scheduled bill-pay to a school or utility, or an
  // ordinary purchase whose merchant just settled slowly. The tight pass
  // above already missed it, so trust a LONE unlinked in-scope candidate in
  // the wide window when either:
  //   - its descriptor actually resembles the payee (plausibleReceiptCharge),
  //     the same bar the UI suggestion paths use; or
  //   - the amount is distinctive — nothing else in the whole window shares
  //     it — which covers the opaque "CHECK # 254" case where the descriptor
  //     resembles nothing.
  // An already-linked same-amount charge (a different receipt's) is not a
  // competing candidate for this one, so it doesn't block the link — it only
  // costs us the "distinctive amount" path, leaving the name-resemblance one.
  const wide = receiptMatchWindow(anchor, RECEIPT_WIDE_MATCH_AFTER_DAYS);
  const inWide = await db.transaction.findMany({
    where: {
      householdId,
      occurredOn: { gte: wide.from, lte: wide.to },
      AND: [receiptAmountWhere(receipt, total), receiptChargeScopeWhere(receipt), accountScope],
    },
    select: { id: true, merchant: true, rawDescription: true, receipt: { select: { id: true } } },
  });
  const freeInWide = inWide.filter((t) => !t.receipt);
  if (freeInWide.length === 1) {
    const only = freeInWide[0];
    // Distinctiveness is judged across BOTH signs (countAtAmount), not off
    // `inWide` — receiptAmountWhere has already dropped every same-amount
    // refund for a purchase receipt, which would make the amount look
    // falsely unique here.
    if ((await countAtAmount(wide.from, wide.to)) === 1 || plausibleReceiptCharge(receipt, only, aliasMerchants)) {
      await linkReceipt(receipt, only.id);
      return true;
    }
  }
  return false;
}

// Writes the durable enrichment onto the transaction and marks the receipt
// MATCHED. Never touches bucket/category — that stays the normal reassign
// flow (which then learns a MerchantRule keyed on the now-resolved party).
export async function linkReceipt(receipt: Receipt, transactionId: string): Promise<void> {
  const lineItems = receipt.lineItems as ParsedReceiptLineItem[] | null;
  await db.$transaction([
    db.receipt.update({
      where: { id: receipt.id },
      data: { transactionId, matchState: "MATCHED" },
    }),
    db.transaction.update({
      where: { id: transactionId },
      data: {
        ...(receipt.party
          ? { resolvedMerchant: receipt.party, resolvedMerchantIsPerson: receipt.partyIsPerson }
          : {}),
        ...(Array.isArray(lineItems) && lineItems.length > 0 ? { receiptItems: toJson(lineItems) } : {}),
        ...(receipt.totalCents != null ? { receiptTotalCents: receipt.totalCents } : {}),
        // The Venmo/PayPal memo, or an order's stated purpose — shown in the
        // expanded row and fed to the P2P model as a hint (item 2, 2026-08-29).
        ...(receipt.noteText ? { receiptNote: receipt.noteText } : {}),
        // Which P2P app, when the bank descriptor is opaque ("Transfer to
        // Venmo") — drives the "Venmo · Name" title / "Paid with Venmo" line.
        ...(receipt.p2pApp ? { receiptPaidWith: receipt.p2pApp } : {}),
      },
    }),
  ]);
  if (receipt.isRefund) await linkRefundToPurchase(receipt, transactionId);
}

// A refund receipt that names the card the money goes back to ("refunded to
// Mastercard ending 1234") only matches a credit on that card's own account —
// when an account with that ending exists; otherwise no extra scope.
async function refundAccountScope(householdId: string, receipt: Receipt): Promise<Prisma.TransactionWhereInput> {
  if (!receipt.isRefund || !receipt.refundToLast4) return {};
  const accounts = await db.account.findMany({
    where: {
      householdId,
      OR: [{ name: { contains: receipt.refundToLast4 } }, { displayName: { contains: receipt.refundToLast4 } }],
    },
    select: { id: true },
  });
  return accounts.length > 0 ? { accountId: { in: accounts.map((a) => a.id) } } : {};
}

// Ties a matched refund credit back to the purchase it undoes
// (Transaction.reimbursesTransactionId), so that purchase's bucket nets the
// refund instead of the credit floating on its own or waiting in the
// unmatched-refunds queue (household request, 2026-10-04: a $16.13 Sam's
// Club return off a $209.35 order). Evidence, strongest first, among the
// same merchant's unrefunded purchases in the last 90 days
// (findRefundPurchaseCandidates):
//   1. the purchase's own receipt has the same order number, or lists one of
//      the returned items (refundItemsMatch);
//   2. it's the only such purchase at all.
// A matching purchase that's still pending waits — a pending hold is
// replaced by its posted charge (a new row), which a link would orphan; the
// next sync retries (retryRefundPurchaseLinks). Never overrides a link
// that's already set.
async function linkRefundToPurchase(receipt: Receipt, creditId: string): Promise<"linked" | "waiting" | "none"> {
  const credit = await db.transaction.findUnique({
    where: { id: creditId },
    select: { id: true, householdId: true, merchant: true, amountCents: true, occurredOn: true, reimbursesTransactionId: true },
  });
  if (!credit || credit.amountCents >= 0 || credit.reimbursesTransactionId) return "none";

  const since = new Date(credit.occurredOn.getTime() - 90 * 86_400_000);
  const merchants = [credit.merchant, receipt.party].filter((m): m is string => !!m);
  const candidates = await db.transaction.findMany({
    where: {
      householdId: credit.householdId,
      amountCents: { gte: Math.abs(credit.amountCents) },
      occurredOn: { gte: since, lte: credit.occurredOn },
      reimbursedBy: { none: {} },
      // A purchase — never a card payment that happens to carry the store's
      // name (a co-branded card's payment posts as "Sam's Club").
      isTransfer: false,
      debtId: null,
      debtPaymentId: null,
      OR: merchants.map((m) => ({ merchant: { equals: m, mode: "insensitive" as const } })),
    },
    orderBy: { occurredOn: "desc" },
    select: {
      id: true,
      pending: true,
      receipt: { select: { orderNumber: true, lineItems: true } },
    },
  });
  if (candidates.length === 0) return "none";

  const refundItems = (receipt.lineItems as ParsedReceiptLineItem[] | null) ?? [];
  const withEvidence = candidates.filter((c) => {
    if (!c.receipt) return false;
    if (receipt.orderNumber && c.receipt.orderNumber && receipt.orderNumber === c.receipt.orderNumber) return true;
    const items = (c.receipt.lineItems as ParsedReceiptLineItem[] | null) ?? [];
    return refundItems.length > 0 && refundItemsMatch(refundItems, items);
  });
  const pick = withEvidence.length === 1 ? withEvidence[0] : withEvidence.length === 0 && candidates.length === 1 ? candidates[0] : null;
  if (!pick) return "none";
  if (pick.pending) return "waiting";
  await db.transaction.update({ where: { id: credit.id }, data: { reimbursesTransactionId: pick.id } });
  return "linked";
}

// Every sync: a refund receipt already matched to its credit whose original
// purchase was still pending last time (or hadn't synced) gets another try.
async function retryRefundPurchaseLinks(householdId: string): Promise<void> {
  const receipts = await db.receipt.findMany({
    where: {
      householdId,
      isRefund: true,
      matchState: "MATCHED",
      transactionId: { not: null },
      transaction: { reimbursesTransactionId: null },
      receivedAt: { gte: daysAgo(30) },
    },
  });
  for (const r of receipts) await linkRefundToPurchase(r, r.transactionId!);
}

// Multi-leg counterpart of linkReceipt above, for a receipt whose stated
// total split across more than one bank transaction (a bill posting its own
// "online bill pay" convenience fee as a separate charge, a multi-shipment
// order) — see Transaction.extraLegReceiptId's schema comment. The
// largest-amount leg is treated as primary and gets the exact same
// enrichment linkReceipt applies (resolvedMerchant/receiptItems/receiptNote/
// receiptPaidWith) plus the transactionId FK every other surface in the app
// already reads off Receipt; every other leg only gets tagged via
// extraLegReceiptId — no enrichment of its own, since its merchant text is
// often a genuinely different real thing (a payment processor's fee line),
// not the receipt's actual party. Deliberately never sets receiptTotalCents
// here (unlike linkReceipt): that field drives the "Receipt Shows $X, $Y
// Charged" mismatch flag (transaction-row.tsx), which would misfire on the
// primary leg — the legs *together* equal the total by design, so there's
// no real discrepancy to flag.
export async function linkReceiptToTransactionLegs(receipt: Receipt, transactionIds: string[]): Promise<void> {
  const legs = await db.transaction.findMany({ where: { id: { in: transactionIds } } });
  const primary = legs.reduce((a, b) => (Math.abs(b.amountCents) > Math.abs(a.amountCents) ? b : a));
  const extraIds = legs.filter((l) => l.id !== primary.id).map((l) => l.id);
  const lineItems = receipt.lineItems as ParsedReceiptLineItem[] | null;

  await db.$transaction([
    db.receipt.update({
      where: { id: receipt.id },
      data: { transactionId: primary.id, matchState: "MATCHED" },
    }),
    db.transaction.update({
      where: { id: primary.id },
      data: {
        ...(receipt.party
          ? { resolvedMerchant: receipt.party, resolvedMerchantIsPerson: receipt.partyIsPerson }
          : {}),
        ...(Array.isArray(lineItems) && lineItems.length > 0 ? { receiptItems: toJson(lineItems) } : {}),
        ...(receipt.noteText ? { receiptNote: receipt.noteText } : {}),
        ...(receipt.p2pApp ? { receiptPaidWith: receipt.p2pApp } : {}),
      },
    }),
    ...(extraIds.length > 0
      ? [db.transaction.updateMany({ where: { id: { in: extraIds } }, data: { extraLegReceiptId: receipt.id } })]
      : []),
  ]);
}

// Writes the itemization from a BNPL purchase receipt onto the plan (Debt)
// and marks the receipt MATCHED_TO_PLAN. The bank only sees the installment
// payments, so Debt.receiptItems is the only home the purchase's line items
// have. Bucket/category untouched, same as linkReceipt.
export async function linkReceiptToPlan(receipt: Receipt, debtId: string): Promise<void> {
  const lineItems = receipt.lineItems as ParsedReceiptLineItem[] | null;
  await db.$transaction([
    db.receipt.update({
      where: { id: receipt.id },
      data: { debtId, transactionId: null, matchState: "MATCHED_TO_PLAN" },
    }),
    db.debt.update({
      where: { id: debtId },
      data: {
        ...(Array.isArray(lineItems) && lineItems.length > 0 ? { receiptItems: toJson(lineItems) } : {}),
        ...(receipt.totalCents != null ? { receiptTotalCents: receipt.totalCents } : {}),
      },
    }),
  ]);
}

// Last-resort match for a purchase receipt with no bank transaction: a
// tracked BNPL installment plan (Debt, debtType INSTALLMENT). Conservative —
// only an unambiguous single plan whose merchant, original principal and
// purchase date all line up (see bnpl-plan-match.ts). An unclaimed plan
// (no receipt yet) is the normal link target, so two same-price same-day
// purchases (a CR-V and an F-150 windshield, both $200 Afterpay) each land
// on their own plan — but a plan that's *already* claimed is still checked
// as a "you're already accounted for" fallback below, not just skipped
// outright: a BNPL purchase routinely generates two independent
// confirmation emails — the retailer's own order confirmation and the
// lender's own purchase confirmation — each carrying its own order number,
// so retireIfDuplicate's order-number dedup key (above) never recognizes
// them as the same event. Without this fallback the second one sits as a
// permanently orphaned "no matching charge yet" with zero candidates
// forever (real case: one $203.78 Nike/Klarna order confirmed by both
// Nike's own system and Klarna's, six seconds apart, 2026-09-04).
async function matchReceiptToBnplPlan(householdId: string, receipt: Receipt, total: number): Promise<void> {
  if (!receipt.party || receipt.partyIsPerson || isP2PReceipt(receipt)) return;

  const anchor = receipt.occurredOn ?? receipt.receivedAt;
  const plans = await db.debt.findMany({
    where: { householdId, debtType: "INSTALLMENT", hiddenAt: null },
    select: {
      id: true,
      name: true,
      balanceCents: true,
      minPaymentCents: true,
      installmentsTotal: true,
      purchaseDate: true,
      debtPayment: { select: { amountDueCents: true } },
      receipts: { select: { id: true } },
    },
  });

  const matchesRule = (p: (typeof plans)[number]) =>
    bnplPlanMatchesReceipt(
      {
        name: p.name,
        balanceCents: p.balanceCents,
        minPaymentCents: p.minPaymentCents,
        installmentsTotal: p.installmentsTotal,
        purchaseDate: p.purchaseDate,
        perInstallmentCents: p.debtPayment?.amountDueCents ?? null,
      },
      { party: receipt.party, totalCents: total },
      anchor,
    );

  const unclaimed = plans.filter((p) => p.receipts.length === 0).filter(matchesRule);
  if (unclaimed.length === 1) {
    await linkReceiptToPlan(receipt, unclaimed[0].id);
    return;
  }

  const redundant = plans.filter((p) => p.receipts.length > 0).filter(matchesRule);
  if (redundant.length === 1) {
    await db.receipt.update({ where: { id: receipt.id }, data: { matchState: "STALE" } });
  }
}

// ---------------------------------------------------------------------------
// Purge

export async function purgeStaleReceipts(householdId: string): Promise<void> {
  const cutoff = new Date(Date.now() - UNMATCHED_TTL_MS);
  await db.receipt.deleteMany({
    where: {
      householdId,
      OR: [
        { matchState: { in: ["STALE", "DISMISSED"] } },
        { matchState: { in: ["UNMATCHED", "AMBIGUOUS"] }, createdAt: { lt: cutoff } },
        // Also retire by the receipt's own date, not just when we first saw
        // it — a re-ingested 2-month-old order confirmation (e.g. after a
        // backfill re-scan) whose charge never posted shouldn't get a fresh
        // 30-day lease just because its row is new. (2026-08-31)
        { matchState: { in: ["UNMATCHED", "AMBIGUOUS"] }, occurredOn: { lt: cutoff } },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard "Receipt Matching" card

// Household-wide count of email receipts that matched more than one bank
// transaction and need a human to pick the right one. AMBIGUOUS is the right
// signal: matchOneReceipt() auto-links a lone candidate and leaves a
// no-candidate receipt UNMATCHED (nothing the user can do yet), so only
// AMBIGUOUS genuinely awaits them. Same set the /settings/email ReceiptLinker
// queue shows, minus its per-user scoping.
export async function getReceiptsAwaitingMatchCount(householdId: string): Promise<number> {
  return db.receipt.count({
    where: { householdId, transactionId: null, matchState: "AMBIGUOUS", totalCents: { not: null } },
  });
}

// Dashboard "Receipt Matching" card — dismissed per calendar week (currentWeekKey),
// exactly like isBillsThisWeekDismissed / dismissBillsThisWeek in
// recurring-bills.ts: next week's key won't match, so the card returns on its
// own if the queue is still non-empty.
export async function isReceiptMatchReviewDismissed(householdId: string): Promise<boolean> {
  const row = await db.suggestionDismissal.findUnique({
    where: { householdId_kind_key: { householdId, kind: "RECEIPT_MATCH_REVIEW", key: currentWeekKey() } },
  });
  return Boolean(row);
}

export async function dismissReceiptMatchReview(householdId: string): Promise<void> {
  await db.suggestionDismissal.upsert({
    where: { householdId_kind_key: { householdId, kind: "RECEIPT_MATCH_REVIEW", key: currentWeekKey() } },
    create: { householdId, kind: "RECEIPT_MATCH_REVIEW", key: currentWeekKey() },
    update: {},
  });
}
