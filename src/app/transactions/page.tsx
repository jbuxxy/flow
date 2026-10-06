import { redirect } from "next/navigation";
import { PAYMENT_RECEIPT_SELECT } from "@/lib/payment-receipt";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { hasFullAccess } from "@/lib/access";
import { getLabelSuggestionsByMerchant } from "@/lib/transaction-labels";
import { getReimbursementSuggestions } from "@/lib/reimbursements";
import { budgetTrackedWhere } from "@/lib/budget-tracked";
import { unlabeledP2PWhere } from "@/lib/p2p-transfers";
import { getUnmatchedRefunds } from "@/lib/refund-match";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { allBnplKeywords } from "@/lib/bnpl-detect";
import { CARD_PAYMENT_MERCHANT_CONTAINS_TERMS, LOAN_TRANSFER_CONTAINS_TERMS } from "@/lib/debt-payment-pattern";
import { pickableDebtWhere } from "@/lib/debt-reassign";
import { installmentNumbersForTransactions } from "@/lib/debt-payments";
import { installmentDisplayTitle, installmentDisplaySuffix } from "@/lib/transaction-display";
import { serializePatternDates } from "@/lib/pattern-data";
import { currentPeriodKey, utcPeriodBounds } from "@/lib/period";
import { todayAsUTCDate } from "@/lib/date";
import { AppShell } from "@/components/app-shell";
import { ResultCount } from "@/components/result-count";
import {
  isP2PReceipt,
  plausibleReceiptCharge,
  receiptSignMatches,
  RECEIPT_MATCH_BEFORE_DAYS,
  RECEIPT_MATCH_AFTER_DAYS,
} from "@/lib/receipt-match";
import { TransactionFilters } from "./transaction-filters";
import { TransactionRow, type ReceiptLineItem } from "./transaction-row";
import type { Prisma } from "@prisma/client";

type ReceiptSuggestion = {
  id: string;
  party: string | null;
  p2pApp: string | null;
  totalCents: number | null;
  itemSummary: string | null;
  noteText: string | null;
};

function summarizeReceiptItems(lineItems: unknown): string | null {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  const names = lineItems
    .map((li) => (li && typeof li === "object" ? String((li as { description?: unknown }).description ?? "") : ""))
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown}…` : shown;
}

// A receipt's bank charge posts on or after the receipt date, so this
// prompt only offers a receipt for a transaction from a small slack before
// the receipt out to the full window after it (see receiptMatchWindow).
const RECEIPT_MATCH_BEFORE_MS = RECEIPT_MATCH_BEFORE_DAYS * 24 * 60 * 60 * 1000;
const RECEIPT_MATCH_AFTER_MS = RECEIPT_MATCH_AFTER_DAYS * 24 * 60 * 60 * 1000;

// Unmatched receipts (from any household member's inbox) keyed to the
// on-page transaction whose amount + date they line up with — the lighter
// counterpart to matchReceipts' automatic linking and the /settings/email
// full picker.
async function buildReceiptSuggestions(
  householdId: string,
  transactions: {
    id: string;
    merchant: string;
    rawDescription: string | null;
    amountCents: number;
    occurredOn: Date;
    receipt: { id: string } | null;
  }[],
): Promise<Record<string, ReceiptSuggestion>> {
  const needy = transactions.filter((t) => !t.receipt);
  if (needy.length === 0) return {};

  // A receipt can only ever match a transaction whose date falls within
  // RECEIPT_MATCH_BEFORE/AFTER of the receipt's own anchor date (checked
  // per-pair below) — so a receipt whose anchor falls outside this page's
  // transactions' combined window could never match any of them anyway.
  // Pushing that same bound into the query (rather than fetching every
  // UNMATCHED/AMBIGUOUS receipt the household has ever had) keeps this
  // page's O(needy × receipts) matching pass bounded as stale unmatched
  // receipts accumulate over time, with identical results.
  const occurredOnMs = needy.map((t) => t.occurredOn.getTime());
  const windowStart = new Date(Math.min(...occurredOnMs) - RECEIPT_MATCH_AFTER_MS);
  const windowEnd = new Date(Math.max(...occurredOnMs) + RECEIPT_MATCH_BEFORE_MS);

  const receipts = await db.receipt.findMany({
    where: {
      householdId,
      transactionId: null,
      matchState: { in: ["UNMATCHED", "AMBIGUOUS"] },
      totalCents: { not: null },
      // anchor = occurredOn ?? receivedAt, same as the in-memory check below.
      OR: [
        { occurredOn: { gte: windowStart, lte: windowEnd } },
        { occurredOn: null, receivedAt: { gte: windowStart, lte: windowEnd } },
      ],
    },
    select: {
      id: true,
      kind: true,
      party: true,
      partyIsPerson: true,
      p2pApp: true,
      totalCents: true,
      occurredOn: true,
      receivedAt: true,
      noteText: true,
      isRefund: true,
      lineItems: true,
    },
    orderBy: { receivedAt: "desc" },
  });
  if (receipts.length === 0) return {};

  const out: Record<string, ReceiptSuggestion> = {};
  const claimed = new Set<string>();
  for (const t of needy) {
    const amount = Math.abs(t.amountCents);
    const txnLooksP2P = P2P_DISCOVERY_KEYWORDS.some((k) => t.merchant.toLowerCase().includes(k));
    const match = receipts.find((r) => {
      if (claimed.has(r.id) || r.totalCents !== amount) return false;
      // A purchase receipt only ever attaches to a debit, a "you received"
      // P2P notice only to a credit — same sign rule as receiptAmountWhere.
      if (!receiptSignMatches(r, t.amountCents)) return false;
      const anchor = r.occurredOn ?? r.receivedAt;
      const delta = t.occurredOn.getTime() - anchor.getTime();
      if (delta < -RECEIPT_MATCH_BEFORE_MS || delta > RECEIPT_MATCH_AFTER_MS) return false;
      // Same P2P-in / P2P-out + name-resemblance gate as matchReceipts
      // (item 3/4, 2026-08-29).
      if (isP2PReceipt(r) !== txnLooksP2P) return false;
      return plausibleReceiptCharge(r, t);
    });
    if (match) {
      claimed.add(match.id);
      out[t.id] = {
        id: match.id,
        party: match.party,
        p2pApp: match.p2pApp,
        totalCents: match.totalCents,
        itemSummary: summarizeReceiptItems(match.lineItems),
        noteText: match.noteText,
      };
    }
  }
  return out;
}

const PAGE_SIZE = 50;

type Status =
  | "all"
  | "uncategorized"
  | "bucket"
  | "debt"
  | "income"
  | "transfer"
  | "unresolvedBnpl"
  | "unresolvedDebt"
  | "unlabeledP2P"
  | "notIncome"
  | "moneyIn"
  | "unmatchedRefund"
  | "pending";

// Every "Needs Review" status (see STATUS_OPTIONS in transaction-filters.tsx)
// exists specifically so a household can hunt down one flagged transaction
// regardless of its age — the DEFAULT_DATE_WINDOW_DAYS default below must
// never apply to these, or it silently reintroduces the "hidden transaction"
// bug this page was built to fix (see the module comment above statusWhere's
// caller, and WORKING_ON.md's 2026-08-14 entry).
const REVIEW_QUEUE_STATUSES = new Set<Status>([
  "uncategorized",
  "unresolvedDebt",
  "unresolvedBnpl",
  "unlabeledP2P",
  "unmatchedRefund",
]);

const DEFAULT_DATE_WINDOW_DAYS = 90;

// Prisma-clause equivalent of CARD_PAYMENT_MERCHANT_PATTERN
// (src/lib/debt-payment-pattern.ts, also reused client-side by
// transaction-row.tsx's own classificationLabel/Reclassify-dropdown logic)
// — shared by the "transfer"/"unresolvedDebt" cases below so a
// debt/card-payment-looking merchant is excluded from one and included in
// the other consistently. The "transfer" branch requires a loan-context word
// alongside `startsWith("transfer")` (AND, not just the prefix alone) for
// the same reason the regex does — see CARD_PAYMENT_MERCHANT_PATTERN's
// comment.
function looksLikeDebtPaymentWhere(): Prisma.TransactionWhereInput {
  return {
    OR: [
      ...CARD_PAYMENT_MERCHANT_CONTAINS_TERMS.map((s) => ({ merchant: { contains: s, mode: "insensitive" as const } })),
      {
        AND: [
          { merchant: { startsWith: "transfer", mode: "insensitive" as const } },
          { OR: LOAN_TRANSFER_CONTAINS_TERMS.map((s) => ({ merchant: { contains: s, mode: "insensitive" as const } })) },
        ],
      },
    ],
  };
}

function statusWhere(status: Status, householdId: string, bnplKeywords: string[]): Prisma.TransactionWhereInput {
  switch (status) {
    // Excludes P2P merchants (own dedicated "unlabeledP2P" status below,
    // same shape uncategorizedTransactionWhere in src/lib/buckets.ts
    // excludes for the dashboard/buckets card) so the two filters stay
    // non-overlapping — a P2P debit sits in this exact bucketId:null/
    // isTransfer:false/isIncome:false state by default too. Debit-only
    // (amountCents > 0) for the same reason — a not-yet-linked refund
    // candidate (see isRefundCandidate, transaction-row.tsx) sits in this
    // exact state on the credit side, but it's never getting a bucket via
    // the Move flow this queue implies (a credit never gets that row
    // action; a refund candidate's own action is Link, surfaced instead by
    // its own "Possible Refunds"/getUnmatchedRefunds queue) — showing it
    // here just double-counted it under an action that doesn't apply (real
    // household request, 2026-09-06).
    case "uncategorized":
      return {
        bucketId: null,
        isIncome: false,
        isTransfer: false,
        amountCents: { gt: 0 },
        NOT: { OR: P2P_DISCOVERY_KEYWORDS.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) },
      };
    case "bucket":
      return { bucketId: { not: null } };
    case "debt":
      return { debtId: { not: null } };
    case "income":
      return { isIncome: true };
    // Real internal transfers only (matchInternalTransfers, checking<->
    // savings) — "transfer" means only that, never anything else (2026-08-25
    // household rule). Excludes an unresolved BNPL-keyword charge and a
    // debt/card-payment-looking charge, both also isTransfer:true/
    // debtId:null but neither a settled internal move — see "unresolvedBnpl"
    // and "unresolvedDebt" below. Real report, 2026-08-24: BNPL charges used
    // to be indistinguishable here, both just labeled "Transfer"; the same
    // gap existed for debt-payment-looking ones until 2026-08-25. Also
    // excludes true P2P merchant text (2026-09-09) — narrowing
    // looksLikeDebtPaymentWhere's transfer branch to require a loan-context
    // word means an unresolved "Transfer from Venmo" reimbursement no longer
    // matches that clause, so it must be excluded here directly instead of
    // falling through and getting mislabeled a real internal "Transfer".
    case "transfer":
      return {
        isTransfer: true,
        debtId: null,
        NOT: {
          OR: [
            ...bnplKeywords.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })),
            ...P2P_DISCOVERY_KEYWORDS.filter((k) => k !== "paypal").map((k) => ({
              merchant: { contains: k, mode: "insensitive" as const },
            })),
            looksLikeDebtPaymentWhere(),
          ],
        },
      };
    // The other half of the isTransfer:true/debtId:null split above — a
    // charge that merely *looks* BNPL-related by merchant text but hasn't
    // been attributed to a specific tracked plan (or ever will be, if it's
    // from a plan nobody's tracking — see releaseBnplCluster, src/lib/bnpl-detect.ts,
    // for how dismissing that plan's suggestion resolves these instead of
    // leaving them stuck here forever).
    case "unresolvedBnpl":
      return {
        isTransfer: true,
        debtId: null,
        OR: bnplKeywords.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })),
      };
    // A third isTransfer:true/debtId:null case (2026-08-25) — a checking-
    // side "Transfer to Loan"/"Capital One Credit Card Payment" line that
    // looks like a debt/card payment (same CARD_PAYMENT_MERCHANT_PATTERN
    // heuristic offering "Debt payment" in the Reclassify dropdown) but
    // couldn't be pinned to one specific tracked Debt — ambiguous (two cards
    // within tolerance of the same minimum payment) or just not tracked yet.
    // Excludes anything BNPL-keyword-matching too, same precedence
    // classificationLabel (transaction-row.tsx) uses. Doesn't also check
    // debtNameMatchesMerchant (a merchant string matching a tracked debt's
    // own name, e.g. a co-branded card posting as the store's name) — that
    // needs each debt's name, not just a static keyword list, and the
    // resulting scope difference here only affects a filtered list view, not
    // the per-row classification badge (which does check it).
    //
    // Also excludes true P2P merchant text (venmo/zelle/cash app/apple
    // cash), same as "uncategorized" above excludes P2P_DISCOVERY_KEYWORDS —
    // a P2P debit whose text happens to contain "payment" is never actually
    // a card/loan payment. "paypal" stays reachable here on purpose: unlike
    // the other P2P apps it can be a real PayPal Credit debt payment (see
    // p2p-keywords.ts's own header comment on that ambiguity).
    case "unresolvedDebt":
      return {
        isTransfer: true,
        debtId: null,
        ...looksLikeDebtPaymentWhere(),
        NOT: {
          OR: [
            ...bnplKeywords.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })),
            ...P2P_DISCOVERY_KEYWORDS.filter((k) => k !== "paypal").map((k) => ({
              merchant: { contains: k, mode: "insensitive" as const },
            })),
          ],
        },
      };
    // The former /transfers page's review queue — a P2P credit/debit with
    // no bucket/debt/income disposition yet and no pattern claiming it. See
    // unlabeledP2PWhere (src/lib/p2p-transfers.ts) for the exact shape,
    // shared with the dashboard/buckets/income attention-card counts.
    case "unlabeledP2P":
      return unlabeledP2PWhere(householdId);
    // Everything but income — the /buckets "Spending" shortcut's filter.
    // Broader than "debit only" on purpose: a debt payment or an
    // uncategorized/bucketed credit (a reimbursement, say) isn't income
    // either, and a household glancing at "what's not income" wants those
    // in view too, not silently dropped.
    case "notIncome":
      return { isIncome: false };
    // Every credit, not just ones classified isIncome — the /income
    // "Money in" shortcut's filter. amountCents < 0 is the same "money in"
    // convention TransactionRow displays without a minus sign (see
    // WORKING_ON.md) — catches a credit transfer (a P2P reimbursement) or
    // an unclassified deposit that a strict isIncome:true filter would miss.
    // But a payment toward your own card/loan also posts as a credit on
    // that account's own feed — mechanically "money in", yet just you
    // paying yourself, never income and confusing to see here. Drop
    // anything already tied to a tracked debt, plus the card-issuer
    // payment descriptors ("… Credit Card Payment", "AUTOPAY") that land
    // on the card's feed before matchDebtPayments has linked them.
    case "moneyIn":
      return {
        amountCents: { lt: 0 },
        debtId: null,
        NOT: {
          OR: CARD_PAYMENT_MERCHANT_CONTAINS_TERMS.map((s) => ({
            merchant: { contains: s, mode: "insensitive" as const },
          })),
        },
      };
    // SimpleFIN's "not settled yet" flag — a household hunting for one of
    // these to check whether it's cleared, rather than a queue implying a
    // decision is owed (see this file's own STATUS_OPTIONS comment).
    case "pending":
      return { pending: true };
    // Deliberately absent here — "ambiguous refund" isn't a plain WHERE
    // clause (it depends on a per-credit candidate count, see
    // getUnmatchedRefunds, src/lib/refund-match.ts) the way every other
    // status above is. The page component resolves the exact id list itself
    // and filters on that directly instead of going through this function.
    default:
      return {};
  }
}

function parseDollarsParam(param: string | undefined): number | undefined {
  if (!param) return undefined;
  const dollars = parseFloat(param);
  return Number.isNaN(dollars) ? undefined : Math.round(dollars * 100);
}

// Amount is signed (debit positive, credit negative — see WORKING_ON.md),
// but the filter fields are plain "$ min"/"$ max" with no direction of
// their own, matching how every row displays its amount (always a bare
// dollar figure, sign shown separately via color/prefix) — so this matches
// on absolute value, mirrored across zero to cover both a debit and a
// credit of the same magnitude.
function amountRangeWhere(minParam: string | undefined, maxParam: string | undefined): Prisma.TransactionWhereInput {
  const minCents = parseDollarsParam(minParam);
  const maxCents = parseDollarsParam(maxParam);
  if (minCents === undefined && maxCents === undefined) return {};
  if (minCents === undefined) return { amountCents: { gte: -maxCents!, lte: maxCents! } };
  if (maxCents === undefined) {
    return { OR: [{ amountCents: { gte: minCents } }, { amountCents: { lte: -minCents } }] };
  }
  return {
    OR: [
      { amountCents: { gte: minCents, lte: maxCents } },
      { amountCents: { gte: -maxCents, lte: -minCents } },
    ],
  };
}

// Matches the search box against merchant, tag (Transaction.label), bucket
// name, and bill category name — one free-text box standing in for what
// would otherwise be separate Tag/Category/Bucket filter dropdowns.
function searchWhere(q: string): Prisma.TransactionWhereInput {
  const contains = { contains: q, mode: "insensitive" as const };
  return {
    OR: [
      { merchant: contains },
      { label: contains },
      { bucket: { name: contains } },
      { bill: { category: { name: contains } } },
    ],
  };
}

// The general-purpose "every transaction, regardless of classification
// state" audit view — unlike a bucket's own "This month" list (current
// period, unbilled only) or the "Needs a bucket" queue (uncategorized only,
// 60-day cutoff), this page applies no implicit *classification* filter.
// Exists because the matching pipelines (matchBillPayments,
// matchIncomePayments, RecurringPattern) can link/tag a transaction in ways
// that remove it from every other page's list — this is the one place a
// household can always find it again. See WORKING_ON.md for the full
// rationale. It does default plain browsing to a recent date window
// (isDefaultDateWindow below, 2026-09-23) so the list doesn't grow
// unbounded — but every "Needs Review" queue and any other explicit filter
// (search/account/debtId/date) still runs unbounded, preserving that
// find-it-again guarantee.
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    from?: string;
    to?: string;
    status?: string;
    debtId?: string;
    q?: string;
    page?: string;
    budgetOnly?: string;
    amountMin?: string;
    amountMax?: string;
    allTime?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!hasFullAccess(session.user)) redirect("/");

  const params = await searchParams;
  const householdId = session.user.householdId;
  // UTC-bounded current calendar month — feeds serializePatternDates' own
  // cyclePaymentStatus computation below (see utcPeriodBounds's own doc
  // comment: Transaction.occurredOn/RecurringPattern.nextDueDate are both
  // UTC-midnight @db.Date values).
  const { start: monthStart, end: monthEnd } = utcPeriodBounds(currentPeriodKey());
  const status: Status = [
    "uncategorized",
    "bucket",
    "debt",
    "income",
    "transfer",
    "unresolvedBnpl",
    "unresolvedDebt",
    "unlabeledP2P",
    "notIncome",
    "moneyIn",
    "unmatchedRefund",
    "pending",
  ].includes(params.status ?? "")
    ? (params.status as Status)
    : "all";
  const page = Math.max(1, Number(params.page) || 1);
  // Defaulted on — only an explicit "0" turns it off, so a plain /transactions
  // URL (no query at all) still scopes to budget-relevant accounts, while
  // still leaving the true "every transaction, no implicit filter" audit
  // view (see the module comment above) one tap away.
  const budgetOnly = params.budgetOnly !== "0";
  const bnplKeywords = await allBnplKeywords(householdId);
  // See statusWhere's own comment on why this status can't be a plain WHERE
  // clause — resolved as an explicit id list instead.
  const unmatchedRefundIds =
    status === "unmatchedRefund" ? (await getUnmatchedRefunds(householdId)).map((r) => r.id) : null;

  // Bounds the plain "just browsing" view to a recent window so the list
  // doesn't grow forever — but only when nothing else is narrowing the
  // query already (an explicit date/account/search/debtId, or a "Needs
  // Review" queue status that exists precisely to surface something old —
  // see REVIEW_QUEUE_STATUSES above). ?allTime=1 (the "Show All Time" link
  // below) opts back out to the page's original unbounded behavior.
  const isDefaultDateWindow =
    !params.from &&
    !params.to &&
    !params.q &&
    !params.account &&
    !params.debtId &&
    !params.amountMin &&
    !params.amountMax &&
    params.allTime !== "1" &&
    !REVIEW_QUEUE_STATUSES.has(status);
  const defaultFrom = isDefaultDateWindow
    ? new Date(todayAsUTCDate().getTime() - DEFAULT_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    : null;

  // Each condition lives as its own AND-array entry rather than being
  // spread flatly into one object — statusWhere/amountRangeWhere and the
  // search clause below can each independently need their own top-level
  // `OR`, and flat-spreading would let a later `OR` silently clobber an
  // earlier one (same object key, last write wins) instead of both
  // applying.
  const where: Prisma.TransactionWhereInput = {
    AND: [
      { householdId },
      unmatchedRefundIds ? { id: { in: unmatchedRefundIds } } : statusWhere(status, householdId, bnplKeywords),
      ...(budgetOnly ? [budgetTrackedWhere()] : []),
      ...(params.account ? [{ accountId: params.account }] : []),
      // Not exposed in TransactionFilters' own UI — set by DebtRow's compact
      // "N Venmo patterns" link to scope straight to one debt's own matched
      // transactions, same as ?status=debt but narrowed further.
      ...(params.debtId ? [{ debtId: params.debtId }] : []),
      // Free-text search reaches beyond the merchant name — a tag (the
      // household's own hand-set label), a bucket's name, or a bill's
      // category all match too, so typing "groceries" finds both a
      // "Groceries"-bucketed purchase and one merely tagged that way,
      // without needing separate Tag/Category/Bucket filter fields.
      ...(params.q ? [searchWhere(params.q)] : []),
      ...(params.from || params.to || defaultFrom
        ? [
            {
              occurredOn: {
                ...(params.from ? { gte: new Date(params.from) } : defaultFrom ? { gte: defaultFrom } : {}),
                ...(params.to ? { lte: new Date(params.to) } : {}),
              },
            },
          ]
        : []),
      amountRangeWhere(params.amountMin, params.amountMax),
    ],
  };

  const [transactions, total, grandTotal, accounts, buckets, debts, categories, bills] = await Promise.all([
    db.transaction.findMany({
      where,
      // occurredOn is date-only (@db.Date), so every transaction on a given
      // day ties on it — without a stable tiebreaker Postgres is free to
      // return the just-updated row first, which made a reassigned ("moved")
      // transaction jump to the top of its day. createdAt keeps each row in
      // its original spot within the day regardless of later edits.
      orderBy: [{ occurredOn: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        bucket: { select: { name: true } },
        // label/debtType feed the label chip's effective-label precedence
        // below — an INSTALLMENT (BNPL) debt's own label is the single
        // source of truth for its linked payments' displayed label, not a
        // separately-tracked Transaction.label copy (2026-08-25 consolidation).
        debt: { select: { name: true, label: true, debtType: true, installmentsTotal: true } },
        category: { select: { name: true } },
        bill: { select: { name: true, category: { select: { name: true } } } },
        income: { select: { id: true, name: true, amountCents: true, cadence: true, nextPayDate: true } },
        // Full pattern data, not just its label — feeds the inline
        // edit/delete panel behind the Repeat badge (transaction-row.tsx),
        // reusing the same field set PatternRow's own edit form uses.
        pattern: {
          select: {
            id: true,
            label: true,
            direction: true,
            channelKeyword: true,
            amountMinCents: true,
            amountMaxCents: true,
            dayOfMonthStart: true,
            dayOfMonthEnd: true,
            weekdays: true,
            bucketId: true,
            bucket: { select: { name: true } },
            debtId: true,
            debt: { select: { name: true } },
            countsAsIncome: true,
            billId: true,
            bill: { select: { name: true } },
            categoryId: true,
            category: { select: { name: true } },
            counterpartyName: true,
            noteKeywords: true,
            cadence: true,
            nextDueDate: true,
            lastPaidDate: true,
            toleranceCents: true,
            dueDateLocked: true,
            active: true,
            createdAt: true,
            transactions: { orderBy: { occurredOn: "desc" }, select: { id: true, amountCents: true, occurredOn: true, pending: true, ...PAYMENT_RECEIPT_SELECT } },
          },
        },
        account: { select: { name: true, displayName: true, budgetTracked: true } },
        reimbursesTransaction: { select: { id: true, merchant: true, amountCents: true, occurredOn: true } },
        // The reverse side — every credit that reimburses *this* charge, so
        // the original purchase can show "Reimbursed by X" too, not just the
        // credit showing "Reimburses X" (2026-09-24 household report: the
        // Verizon charge a Venmo payment paid back had no indication of it).
        reimbursedBy: { select: { id: true, merchant: true, amountCents: true, occurredOn: true } },
        // Split-credit offsets (see TransactionOffset) — for the ReimbursementLinker.
        offsetsAsCredit: {
          select: {
            id: true,
            amountCents: true,
            debit: { select: { merchant: true, debt: { select: { name: true } } } },
          },
        },
        // receivedAt/occurredOn/totalCents feed the expanded "From Receipt"
        // block's fallback line for a bare receipt (matched by amount+date but
        // carrying no line items or note — e.g. a gas-station email).
        receipt: { select: { id: true, receivedAt: true, occurredOn: true, totalCents: true } },
      },
    }),
    db.transaction.count({ where }),
    // Stable denominator for the "N of M Transactions" line — every
    // transaction in the household, regardless of the active filter set.
    db.transaction.count({ where: { householdId } }),
    db.account.findMany({
      // hiddenAt excludes a retired/superseded account (e.g. linkDebtAccount
      // hiding the old row after SimpleFIN re-issues an account id for the
      // same real card) — otherwise it lingers in this filter dropdown as an
      // indistinguishable duplicate of the live account (same displayName).
      where: { householdId, hiddenAt: null },
      select: { id: true, name: true, orgName: true, displayName: true, budgetTracked: true },
    }),
    db.bucket.findMany({ where: { householdId }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, trackingMode: true } }),
    db.debt.findMany({
      // Hidden debts, and paid-off loans/BNPL plans, stay out of the
      // Reclassify / Track-as-bill pickers below — see pickableDebtWhere.
      where: { householdId, ...pickableDebtWhere() },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        account: { select: { orgName: true, displayName: true } },
        // Used below to exclude a debt that already has a payment tracker —
        // picking one of those in TrackAsBillForm's picker today just
        // produces a server-side "already has a tracked payment" rejection
        // instead of never being offered in the first place.
        debtPayment: { select: { id: true } },
      },
    }),
    db.billCategory.findMany({ where: { householdId }, select: { id: true, name: true, bucketId: true }, orderBy: { name: "asc" } }),
    // Feeds PatternPanel's billId reimbursement dropdown (via TransactionRow)
    // when creating a P2P income pattern with "Count as household income"
    // unchecked — same bills list the former /transfers page passed through.
    db.recurringBill.findMany({
      where: { householdId, active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  // Was prefixed with the synced account's institution ("Capital One ·
  // Venture") to disambiguate generic-sounding lender names in the
  // dropdown — dropped per feedback (2026-08-18): just the friendly name,
  // same as every other debt reference in the app (WORKING_ON.md).
  // Excludes BNPL (always auto-tracked at creation — see AddDebtForm's
  // INSTALLMENT branch — so an existing BNPL debt is never a valid pick
  // here) and any debt that already has a DebtPayment tracker (picking one
  // of those would just hit createDebtPaymentFromTransaction's "already has
  // a tracked payment" rejection). What's left is exactly the debts a
  // household could legitimately attach this transaction to — see
  // debtSetupReason/"Add a due date" in src/lib/debt-payments.ts for the
  // same "a Debt can exist with no tracker yet" state this reflects.
  const debtOptions = debts
    .filter((d) => d.kind !== "BNPL" && !d.debtPayment)
    .map((d) => ({ id: d.id, name: d.account?.displayName ?? d.name, kind: d.kind as "CARD" | "LOAN" }));

  // The opposite filter from debtOptions above, for an entirely different
  // action: reassignTransaction's debtId branch (buckets/actions.ts) is the
  // manual one-off "counts as a payment toward this debt" override — it
  // leaves debtPaymentId:null on purpose, trusting the next
  // matchDebtPayments/matchInstallmentPayments sweep to claim the
  // transaction into the debt's real payment cycle. That only ever resolves
  // if a real DebtPayment cycle already exists to claim it — an untracked
  // debt would leave the transaction permanently orphaned (debtId set,
  // nothing left to ever pick it up). Real report, 2026-08-26: a manual
  // "PayPal Credit" debt (no linked account, so linkUnclassifiedLenderPayments'
  // own lender-name fallback has no orgName to search on either) had its
  // real payment sync in as an ordinary "PAYPAL ..." transaction — generic
  // P2P-branded merchant text that neither the sync-time transfer heuristics
  // nor debtNameMatchesMerchant recognized — with no way to manually attach
  // it, because the Reclassify dropdown was drawing from this same
  // untracked-only debtOptions list.
  const attachableDebtOptions = debts.filter((d) => d.debtPayment).map((d) => ({ id: d.id, name: d.account?.displayName ?? d.name }));

  const labelSuggestions = await getLabelSuggestionsByMerchant(
    householdId,
    transactions.map((t) => t.merchant),
  );
  const reimbursementSuggestions = await getReimbursementSuggestions(
    householdId,
    transactions
      .filter((t) => t.amountCents < 0 && !t.reimbursesTransactionId && !t.reimbursesMerchant)
      .map((t) => ({ id: t.id, merchant: t.merchant, amountCents: t.amountCents, occurredOn: t.occurredOn, accountId: t.accountId })),
  );
  const receiptSuggestions = await buildReceiptSuggestions(householdId, transactions);
  // Which installment of its BNPL plan each linked charge is — feeds the
  // "3/6" schedule-position suffix at the end of the subline below
  // (installmentDisplaySuffix).
  const installmentNumbers = await installmentNumbersForTransactions(
    householdId,
    transactions.map((t) => t.id),
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppShell title="All Transactions" user={session.user} width="wide">
      {/* Desktop: filters in a sticky left rail, the ledger stays one
          chronological column on the right (a time-ordered list must not be
          split into columns). Mobile: plain stack. */}
      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-6 lg:items-start">
      <div className="lg:sticky lg:top-4">
      <TransactionFilters
        accounts={accounts}
        current={{
          account: params.account ?? "",
          from: params.from ?? "",
          to: params.to ?? "",
          status,
          q: params.q ?? "",
          budgetOnly,
          amountMin: params.amountMin ?? "",
          amountMax: params.amountMax ?? "",
        }}
      />
      </div>

      <div className="flex flex-col gap-4">
      <ResultCount count={total} noun="Transaction" total={grandTotal} />

      {isDefaultDateWindow && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Showing the Last {DEFAULT_DATE_WINDOW_DAYS} Days ·{" "}
          <a
            href={`/transactions?${allTimeQuery(params)}`}
            className="font-medium text-blue-900 hover:underline dark:text-blue-300"
          >
            Show All Time
          </a>
        </p>
      )}

      {transactions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">No transactions match these filters.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {transactions.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={{
                id: t.id,
                merchant: t.merchant,
                amountCents: t.amountCents,
                occurredOn: t.occurredOn,
                notes: t.notes,
                // A pattern's own label (P2P recurring) or an INSTALLMENT
                // debt's own label (BNPL) is the single source of truth for
                // what a linked payment displays/edits here — falls back to
                // this transaction's own label only when it's unlinked to
                // either (2026-08-25 consolidation, see updateTransactionLabel).
                label: t.pattern?.label ?? (t.debt?.debtType === "INSTALLMENT" ? t.debt.label : null) ?? t.label,
                bucketId: t.bucketId,
                bucketName: t.bucket?.name ?? null,
                debtName: t.debt?.name ?? null,
                // BNPL installment charges title as just "<plan>" — the linked
                // plan is the only stable identity (the bank descriptor on an
                // individual installment is opaque and varies within one plan).
                installmentTitle: installmentDisplayTitle({
                  debtType: t.debt?.debtType ?? null,
                  debtName: t.debt?.name ?? null,
                }),
                // "3/6" schedule position, shown at the end of the subline.
                installmentSuffix: installmentDisplaySuffix({
                  debtType: t.debt?.debtType ?? null,
                  installmentNumber: installmentNumbers.get(t.id) ?? null,
                  installmentsTotal: t.debt?.installmentsTotal ?? null,
                }),
                billName: t.bill?.name ?? null,
                billCategoryName: t.bill?.category?.name ?? null,
                categoryId: t.categoryId,
                categoryName: t.category?.name ?? null,
                aiSuggestedBucketId: t.aiSuggestedBucketId,
                aiSuggestedCategoryId: t.aiSuggestedCategoryId,
                income: t.income,
                pattern: t.pattern
                  ? {
                      id: t.pattern.id,
                      label: t.pattern.label,
                      direction: t.pattern.direction,
                      channelKeyword: t.pattern.channelKeyword,
                      amountMinCents: t.pattern.amountMinCents,
                      amountMaxCents: t.pattern.amountMaxCents,
                      dayOfMonthStart: t.pattern.dayOfMonthStart,
                      dayOfMonthEnd: t.pattern.dayOfMonthEnd,
                      weekdays: t.pattern.weekdays,
                      bucketId: t.pattern.bucketId,
                      bucketName: t.pattern.bucket?.name ?? null,
                      debtId: t.pattern.debtId,
                      debtName: t.pattern.debt?.name ?? null,
                      countsAsIncome: t.pattern.countsAsIncome,
                      billId: t.pattern.billId,
                      billName: t.pattern.bill?.name ?? null,
                      categoryId: t.pattern.categoryId,
                      categoryName: t.pattern.category?.name ?? null,
                      counterpartyName: t.pattern.counterpartyName,
                      noteKeywords: t.pattern.noteKeywords,
                      cadence: t.pattern.cadence,
                      toleranceCents: t.pattern.toleranceCents,
                      dueDateLocked: t.pattern.dueDateLocked,
                      active: t.pattern.active,
                      ...serializePatternDates(t.pattern, monthStart, monthEnd),
                    }
                  : null,
                isIncome: t.isIncome,
                isTransfer: t.isTransfer,
                oneOff: t.oneOff,
                // Just the friendly name, no institution prefix — same
                // "just the friendly name" convention as every other
                // account/debt reference in the app (WORKING_ON.md).
                accountLabel: t.account ? (t.account.displayName ?? t.account.name) : null,
                accountBudgetTracked: t.account ? t.account.budgetTracked : true,
                billId: t.billId,
                debtPaymentId: t.debtPaymentId,
                reimbursesTransaction: t.reimbursesTransaction,
                reimbursesMerchant: t.reimbursesMerchant,
                reimbursedBy: t.reimbursedBy,
                refundReviewDismissed: t.refundReviewDismissed,
                offsets: t.offsetsAsCredit.map((o) => ({
                  id: o.id,
                  amountCents: o.amountCents,
                  debitMerchant: o.debit.merchant,
                  debitDebtName: o.debit.debt?.name ?? null,
                })),
                pending: t.pending,
                rawDescription: t.rawDescription,
                resolvedMerchant: t.resolvedMerchant,
                resolvedMerchantIsPerson: t.resolvedMerchantIsPerson,
                receiptItems: (t.receiptItems as ReceiptLineItem[] | null) ?? null,
                receiptTotalCents: t.receiptTotalCents,
                receiptNote: t.receiptNote,
                receiptPaidWith: t.receiptPaidWith,
                hasReceipt: !!t.receipt,
                receiptDate: t.receipt
                  ? (t.receipt.occurredOn ?? t.receipt.receivedAt).toISOString().slice(0, 10)
                  : null,
                receiptSuggestion: t.receipt ? null : (receiptSuggestions[t.id] ?? null),
              }}
              buckets={buckets}
              debts={debtOptions}
              trackedDebts={attachableDebtOptions}
              bills={bills}
              categories={categories}
              labelSuggestions={labelSuggestions[t.merchant] ?? []}
              reimbursementSuggestions={reimbursementSuggestions[t.id] ?? []}
              bnplKeywords={bnplKeywords}
            />
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <PageLink params={params} page={page - 1} disabled={page <= 1} label="Prev" />
          <span className="text-gray-500 dark:text-neutral-400">
            Page {page} of {totalPages}
          </span>
          <PageLink params={params} page={page + 1} disabled={page >= totalPages} label="Next" />
        </div>
      )}
      </div>
      </div>
    </AppShell>
  );
}

// Carries every other active param forward (status=notIncome from the sidebar
// link, say) while opting out of the default date window — same
// forward-everything-but-page approach as PageLink below, minus page (an
// all-time result set starts back on page 1).
function allTimeQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "page") qs.set(k, v);
  }
  qs.set("allTime", "1");
  return qs.toString();
}

function PageLink({
  params,
  page,
  disabled,
  label,
}: {
  params: Record<string, string | undefined>;
  page: number;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return <span className="rounded-lg px-3 py-1.5 text-neutral-300 dark:text-neutral-700">{label}</span>;
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== "page") qs.set(k, v);
  }
  qs.set("page", String(page));
  return (
    <a
      href={`/transactions?${qs.toString()}`}
      className="rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-1.5 font-medium text-blue-900 dark:text-blue-300"
    >
      {label}
    </a>
  );
}
