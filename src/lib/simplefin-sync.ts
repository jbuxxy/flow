import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { sendPushToHouseholdForType } from "@/lib/push";
import { mapConcurrent } from "@/lib/concurrency";
import { isDemoHousehold } from "@/lib/demo";
import { fetchSimpleFinData, decimalStringToCents, type SimpleFinAccount } from "@/lib/simplefin";
import { checkAndSendGoalAlerts } from "@/lib/savings";
import { autoApplyAdHocIncomeToBuckets } from "@/lib/bucket-ad-hoc-topup";
import { checkAndSendBucketAlertsFor } from "@/lib/buckets";
import { suggestBucketsForMerchants, suggestCategoriesForMerchants, suggestP2PClassifications } from "@/lib/ai";
import { pollHouseholdEmails, matchReceipts, purgeStaleReceipts } from "@/lib/receipt-sync";
import { singleFlight, trackSync } from "@/lib/sync-in-flight";
import { matchBillNoticeAmounts, purgeStaleBillNotices } from "@/lib/bill-notice-sync";
import { reclassifyFromReceipts } from "@/lib/receipt-reclassify";
import { upsertMerchantRule, pickMerchantRule } from "@/lib/merchant-rules";
import { matchOneTimeBucket } from "@/lib/one-time-bucket-match";
import { matchRecurringPattern, patternMatchData } from "@/lib/pattern-match";
import { matchBillPayments } from "@/lib/recurring-bills";
import {
  matchDebtPayments,
  matchInstallmentPayments,
  snapshotPlannedExtraForCurrentWeek,
  unhideDebtPaymentIfBalanceReturned,
  notifyIfDebtJustPaidOff,
} from "@/lib/debt-payments";
import { matchIncomePayments } from "@/lib/income";
import { matchReimbursements } from "@/lib/reimbursements";
import { matchPatternPayments } from "@/lib/pattern-payments";
import {
  bnplAttributionToleranceCents,
  allBnplKeywords,
  checkForNewBnplLenders,
  resolveBnplKeyword,
  backfillBnplKeywords,
} from "@/lib/bnpl-detect";
import { checkForNewSubscriptions } from "@/lib/bill-detect";
import { nextPaidOffDate, nextPaidOffAmountCents } from "@/lib/debt-payoff";
import {
  CARD_PAYMENT_MERCHANT_PATTERN,
  isGenericCardPaymentDescriptor,
  isCardPaymentDescriptor,
  txnTextNamesDebt,
  scopeToNamedDebts,
} from "@/lib/debt-payment-pattern";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { nameSimilarity } from "@/lib/fuzzy-match";
import { pendingRowRetirable, phantomTwinMergeData, settleOrphanPendingInPlace } from "@/lib/pending-twin-merge";
import { todayAsUTCDate } from "@/lib/date";
import { tryAutoLinkRefund, tryAutoLinkGenericCredit } from "@/lib/refund-match";
import { creditDoesNotIdentifyPayee } from "@/lib/reimbursements";
import { stripPendingPrefix } from "@/lib/pending-prefix";
import type { AccountType, SyncMode, DebtType } from "@prisma/client";

// How long an account has to sit missing from its connection's synced
// `accounts` list, continuously, before syncHousehold treats it as actually
// gone (see the missingFromFeedSince debounce there) — long enough to ride
// out a single flaky sync (a 20-minute poll interval means this survives
// several consecutive misses), short enough that a real disconnect still
// disappears same-day, matching the "lingers forever" complaint the
// detection itself was originally built for (2026-08-20).
const GONE_FROM_FEED_GRACE_MS = 2 * 60 * 60 * 1000;

// Hides an Account (Account.hiddenAt) and cascades to hide any Debt still
// linked to it that isn't already hidden — this file's own "gone from the
// SimpleFIN feed" detection below is the *only* caller: there's no manual
// per-account equivalent of this, deliberately (see Account.hiddenAt in
// schema.prisma). Deliberately account-only, not the reverse: hiding just a
// Debt (e.g. a paid-off card the household still actively uses, via
// hideDebt) must never imply the still-connected Account is "gone" too —
// only an Account going hidden implies its Debt should too, never the
// other way around. Undone by restoreAccount
// (src/app/settings/accounts/actions.ts) — see Account.hiddenAt in
// schema.prisma for why this never self-heals on its own.
export async function hideAccountsWithLinkedDebts(accountIds: string[], now: Date = new Date()): Promise<void> {
  if (accountIds.length === 0) return;
  await db.account.updateMany({ where: { id: { in: accountIds } }, data: { hiddenAt: now } });
  await db.debt.updateMany({ where: { accountId: { in: accountIds }, hiddenAt: null }, data: { hiddenAt: now } });
}

// Drops the Asset.debtId link on any appreciable (home/vehicle) asset whose
// securing loan is settled — balance $0, or the debt hidden (its account left
// the feed). See the call site in syncHousehold for the full reasoning; kept
// here beside hideAccountsWithLinkedDebts since the two are the pair that
// reconcile a paid-off/vanished secured loan across /debts and /networth.
// Idempotent and run over every linked equity asset each sync (not just this
// run's balance transitions), so an asset whose loan was already paid off
// before this existed self-heals on the next sync like everything else here.
async function detachSettledEquityDebtLinks(householdId: string): Promise<void> {
  const linked = await db.asset.findMany({
    where: {
      householdId,
      assetType: { in: ["HOME_EQUITY", "VEHICLE_EQUITY"] },
      debtId: { not: null },
    },
    select: { id: true, debt: { select: { balanceCents: true, hiddenAt: true } } },
  });
  const settled = linked
    .filter((a) => a.debt && (a.debt.balanceCents === 0 || a.debt.hiddenAt !== null))
    .map((a) => a.id);
  if (settled.length === 0) return;
  await db.asset.updateMany({ where: { id: { in: settled } }, data: { debtId: null } });
}

// Card issuers whose retail product names (Quicksilver, Venture, Sapphire,
// Freedom...) don't contain any generic "credit card" keyword — there's no
// exhaustive list of every product name, but the issuer list is short and
// stable, so anything from one of these that isn't already a loan/
// investment/deposit account is almost certainly a card.
const KNOWN_CARD_ISSUERS = [
  "capital one",
  "chase",
  "discover",
  "american express",
  "amex",
  "citi",
  "barclays",
  "wells fargo",
  "bank of america",
  "us bank",
  "synchrony",
];

function guessAccountType(a: SimpleFinAccount): AccountType {
  const name = `${a.name} ${a.org?.name ?? ""}`.toLowerCase();
  const orgName = (a.org?.name ?? "").toLowerCase();
  if (name.includes("credit card") || name.includes("visa") || name.includes("mastercard")) return "CREDIT_CARD";
  if (name.includes("loan") || name.includes("mortgage")) return "LOAN";
  if (
    name.includes("401k") ||
    name.includes("401(k)") ||
    name.includes(" ira") ||
    name.includes("roth") ||
    name.includes("brokerage") ||
    name.includes("investment") ||
    name.includes("retirement")
  ) {
    return "INVESTMENT";
  }
  // Money market (savings-style, check-writing privileges but still a
  // liquid deposit account) doesn't contain "saving" or "checking" in most
  // banks' product names, so it needs its own keyword — grouped under
  // SAVINGS since that's what it behaves like for net worth/cash purposes.
  if (name.includes("saving") || name.includes("money market")) return "SAVINGS";
  if (name.includes("checking")) return "CHECKING";
  if (KNOWN_CARD_ISSUERS.some((issuer) => orgName.includes(issuer))) return "CREDIT_CARD";
  return "OTHER";
}

// SimpleFIN's own community-documented limitation: Venmo's balance is
// reliable but its transaction feed isn't, so those accounts fall back to
// balance-only tracking instead of silently showing an empty feed.
// Investment/retirement accounts get the same treatment for a different
// reason: their "transactions" are trades, not household spending, so
// importing them into buckets would just be noise.
function guessSyncMode(a: SimpleFinAccount, accountType: AccountType): SyncMode {
  const name = `${a.name} ${a.org?.name ?? ""}`.toLowerCase();
  if (name.includes("venmo") || accountType === "INVESTMENT") return "BALANCE_ONLY";
  return "TRANSACTIONS";
}

// Gemini's response is one JSON array per call — keep prompts (and thus
// response sizes) bounded regardless of how large a backlog gets swept in.
const AI_BATCH_SIZE = 50;

// Checking-side debt-payment text only ("Loan Payment", "Capital One Credit
// Card Payment") — matched against a household's tracked debts by amount
// below. A bare "Transfer to/from X" is deliberately NOT matched here: bank
// transfer wording varies too much across institutions ("Transfer",
// "Online Transfer", "Internal Transfer") to trust by text alone, and a
// real self-transfer (checking<->savings/money market) is now only ever
// recognized by finding the actual offsetting transaction on another of
// the household's own tracked accounts — see matchInternalTransfers below.
// Asking AI to bucket-file either of these every sync just burns calls and
// produces nonsense, so both stay out of the normal categorization pool.
const DEBT_PAYMENT_TEXT_PATTERN = /credit card payment|^loan payment\b/i;

// The generic "Transfer to Loan" / "Loan Draft" / "Principal Payment" wording
// DEBT_PAYMENT_TEXT_PATTERN deliberately won't touch on text alone — but safe
// to attribute to a specific debt when the household has exactly ONE debt of
// DebtKind.LOAN. A mortgage/auto/trailer-loan servicer typically reports
// balance only (no transaction feed on the loan account itself), so there's
// no offsetting leg for matchInternalTransfers to pair, the lender name never
// shows up in the checking-side text for linkUnclassifiedLenderPayments to
// catch, and the payoff amount is nothing like the tracked minimum so
// findUniqueDebtByMinPayment misses it too. Real report 2026-08-28: a
// $3,523.93 "Transfer to Loan" payoff stuck in "Needs a Bucket" while the
// Trailer Loan it cleared already showed paid-off from the balance feed alone.
const LOAN_TRANSFER_TEXT_PATTERN = /\b(loan|mortgage|principal)\b/i;

// A real internal transfer — checking<->savings, checking<->money market,
// or the reverse — recognized only by finding the actual offsetting
// transaction on another of the household's own tracked depository
// accounts, never by trusting whatever wording the bank used. Runs once,
// up front, over the whole depository candidate pool, since a matched pair
// must never be second-guessed by a later branch (a stale MerchantRule
// keyed on "Online Transfer" filing it into a bucket instead, for
// instance) and both sides need to be marked together in the same pass.
// Deliberately conservative: an ambiguous match (more than one same-
// amount, same-window counterpart) is left alone rather than guessed —
// same "don't guess" convention as findUniqueDebtByMinPayment below.
const INTERNAL_TRANSFER_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
// Wider window for the offsetting-card-leg lookup when a stronger signal (a
// tracked-debt name match, or an ACH payment descriptor on the raw line)
// already establishes the debit is a card payment — the card→checking
// settlement lag on a co-branded card routinely exceeds 2 days. Matches
// filterDebtPaymentTwins' TWIN_WINDOW_DAYS.
const TWIN_LOOKUP_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

async function matchInternalTransfers(
  candidates: {
    id: string;
    amountCents: number;
    occurredOn: Date;
    accountId: string | null;
    account: { accountType: AccountType; budgetTracked: boolean } | null;
  }[],
): Promise<Set<string>> {
  const depository = candidates.filter(
    (t) => t.accountId && (t.account?.accountType === "CHECKING" || t.account?.accountType === "SAVINGS"),
  );
  const matched = new Set<string>();
  for (const t of depository) {
    if (matched.has(t.id)) continue;
    const counterparts = depository.filter(
      (c) =>
        !matched.has(c.id) &&
        c.accountId !== t.accountId &&
        c.amountCents === -t.amountCents &&
        Math.abs(c.occurredOn.getTime() - t.occurredOn.getTime()) <= INTERNAL_TRANSFER_WINDOW_MS,
    );
    if (counterparts.length !== 1) continue; // no match, or ambiguous — leave for normal categorization
    const counterpart = counterparts[0];
    matched.add(t.id);
    matched.add(counterpart.id);
    await db.transaction.updateMany({
      where: { id: { in: [t.id, counterpart.id] } },
      data: { isTransfer: true, bucketId: null, debtId: null, isIncome: false, aiSuggestedBucketId: null },
    });
  }
  return matched;
}

// The checking-side leg of a debt payment — "Transfer to Loan", "Loan
// Draft", a bare "Online Payment" — carries no account link and often no
// lender name, and a lump-sum payoff matches no tracked minimum, so
// matchDebtPayments, findUniqueDebtByMinPayment and the single-LOAN
// LOAN_TRANSFER_TEXT_PATTERN shortcut all miss it once a household has more
// than one loan. But when the debt's own account is also SimpleFIN-tracked,
// the paydown posts there too as a negative (balance-reducing) credit — the
// same two-legged shape matchInternalTransfers pairs for checking<->savings,
// just with a liability account on the other side. Pair them by exact amount
// + date window and attribute the depository leg to whatever debt owns the
// liability account. matchDebtPayments' own filterDebtPaymentTwins then
// keeps the pair from being counted twice (the liability leg, on the debt's
// own account, is the one that actually links to the DebtPayment). Real
// report 2026-08-28: a $3,523.93 "Transfer to Loan" payoff stuck in "Needs a
// Bucket" while its offsetting −$3,523.93 "Payment from Checking" on the
// Trailer Loan account had already cleared the debt.
async function matchDepositoryDebtPaymentLegs(
  householdId: string,
  candidates: {
    id: string;
    amountCents: number;
    occurredOn: Date;
    accountId: string | null;
    account: { accountType: AccountType; budgetTracked: boolean } | null;
  }[],
  debtByAccountId: Map<string, string>,
): Promise<Set<string>> {
  const matched = new Set<string>();
  if (debtByAccountId.size === 0) return matched;
  const depositoryDebits = candidates.filter(
    (t) =>
      t.amountCents > 0 &&
      t.accountId &&
      (t.account?.accountType === "CHECKING" || t.account?.accountType === "SAVINGS"),
  );
  if (depositoryDebits.length === 0) return matched;

  const oldest = new Date(
    Math.min(...depositoryDebits.map((t) => t.occurredOn.getTime())) - INTERNAL_TRANSFER_WINDOW_MS,
  );
  // The paydown legs on the household's own loan accounts — already
  // isTransfer/debtId-tagged (or linked) from a prior branch, so they're not
  // in `candidates`; query them directly. Negative = balance reducing.
  // LOAN only, not CREDIT_CARD: a card feed routinely carries negative
  // *purchase refunds* that look identical to a payment leg here, and the
  // card-payment case already has its own two-legged handling (the
  // CARD_PAYMENT_MERCHANT_PATTERN branch + matchDebtPayments' twin filter).
  const liabilityLegs = await db.transaction.findMany({
    where: {
      householdId,
      accountId: { in: [...debtByAccountId.keys()] },
      account: { accountType: "LOAN" },
      amountCents: { lt: 0 },
      occurredOn: { gte: oldest },
    },
    select: { amountCents: true, occurredOn: true, accountId: true },
  });
  if (liabilityLegs.length === 0) return matched;

  for (const t of depositoryDebits) {
    const debtIds = new Set(
      liabilityLegs
        .filter(
          (l) =>
            l.amountCents === -t.amountCents &&
            Math.abs(l.occurredOn.getTime() - t.occurredOn.getTime()) <= INTERNAL_TRANSFER_WINDOW_MS,
        )
        .map((l) => debtByAccountId.get(l.accountId!))
        .filter((id): id is string => Boolean(id)),
    );
    if (debtIds.size !== 1) continue; // no offsetting leg, or ambiguous — leave for normal categorization
    matched.add(t.id);
    await db.transaction.update({
      where: { id: t.id },
      data: {
        isTransfer: true,
        debtId: [...debtIds][0],
        bucketId: null,
        isIncome: false,
        aiSuggestedBucketId: null,
        aiSuggestedCategoryId: null,
      },
    });
  }
  return matched;
}

// Retro-fix for a co-branded card payment that already got filed as spending.
// On the sync where the checking leg first appeared there may have been no ACH
// payment descriptor to read and no card-side leg yet, so it fell through to
// Groceries. Once the card-side leg posts on a later sync, pull it back out.
// Runs before categorizeUncategorizedTransactions (whose own candidate query
// is scoped to bucketId:null and so can never see these) so a freshly retagged
// row still flows through matchDebtPayments the same sync. Never touches a row
// already linked to a DebtPayment. Deliberately does NOT write a MerchantRule
// — the store name stays genuinely ambiguous (purchases vs. payments), so it's
// a per-transaction decision every time, same as isGenericCardPaymentDescriptor.
async function reconcileCategorizedCardPayments(householdId: string): Promise<void> {
  const debts = await db.debt.findMany({
    where: { householdId },
    select: {
      id: true,
      name: true,
      accountId: true,
      debtType: true,
      bnplKeyword: true,
      account: { select: { orgName: true } },
    },
  });
  if (debts.length === 0) return;
  const bnplKeywords = await allBnplKeywords(householdId);

  const filed = await db.transaction.findMany({
    where: {
      householdId,
      amountCents: { gt: 0 },
      isTransfer: false,
      debtId: null,
      debtPaymentId: null,
      bucketId: { not: null },
      account: { accountType: { in: ["CHECKING", "SAVINGS"] } },
      occurredOn: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    },
    select: {
      id: true,
      merchant: true,
      rawDescription: true,
      amountCents: true,
      occurredOn: true,
      account: { select: { accountType: true } },
    },
  });

  for (const t of filed) {
    const debtId = await resolveCoBrandedCardPayment(householdId, t, debts, bnplKeywords);
    if (!debtId) continue;
    await db.transaction.update({
      where: { id: t.id },
      data: {
        isTransfer: true,
        debtId,
        bucketId: null,
        categoryId: null,
        isIncome: false,
        aiSuggestedBucketId: null,
        aiSuggestedCategoryId: null,
      },
    });
  }
}

// SimpleFIN sends `posted: 0` for a still-pending transaction. The sync
// upsert self-heals to the real posted date *if* the same
// `simpleFinTransactionId` reappears later with one — but the aggregator
// routinely swaps the id the moment the transaction actually posts, so the
// pending row is simply never returned again and sits forever as a phantom
// duplicate of the real, correctly-dated row under the new id: it nags in
// the "Uncategorized"/"Possible BNPL payment" queues and shows as a stray
// duplicate line in every transaction picker. (Until 2026-09, `occurredOn`
// for a still-pending row was hardcoded to the Unix epoch, displayed as a
// bare "Jan 1" — real report, a household mistaking a batch of these for a
// sync bug. Now it's the day we first saw the row, so it reads sanely even
// when a phantom never gets matched below.) No automatic fix existed before
// 2026-08-28 — a one-off cleanup in Aug 2026 retired ~100 such rows by hand,
// and this household kept accumulating a slow trickle of them.
//
// This pass retires them at sync time. A still-pending row that SimpleFIN
// has stopped returning for >= STALE_PENDING_GRACE_MS is, definitionally,
// no longer pending in real life either — the bank has either posted it for
// real (usually under a fresh id, see above) or voided the hold outright.
// Either way there's no real pending money left behind it, so once that
// grace period has passed and nothing else depends on the row, it gets
// deleted — full stop. (Household call, 2026-09-24: earlier this only ever
// deleted a phantom it could confidently re-attribute to one specific
// posted twin, and left everything else — an ambiguous match, a conflicting
// one, no twin at all — sitting in "Pending" forever. That produced a slow
// permanent accumulation of stale duplicate rows, which is worse than the
// (rare, minor) cost of occasionally dropping a phantom's own label/bucket
// override along with it.)
//
// Before deleting, it still makes a best-effort pass at finding the one
// unique real-dated transaction this phantom became, so any classification
// the household put on the *pending* row (a bucket, a label, a manual
// category) survives onto the real one instead of silently vanishing. Two
// ways:
//   1. Same account, same merchant (name-similarity), amount equal or up to
//      TIP_TOLERANCE_MAX_RATIO higher (capped at TIP_TOLERANCE_CAP_CENTS) —
//      a restaurant/rideshare tip added between authorization and posting
//      means the posted charge is routinely a few dollars more than the
//      pending hold, never less and rarely by much (real report, 2026-09-09:
//      a $70.36 pending restaurant hold posted at $83.00).
//   2. A payment-shaped row on a CREDIT_CARD account (merchant matches
//      CARD_PAYMENT_MERCHANT_PATTERN — "Credit Card Payment", "ONETIMEPAYMENT")
//      is looked up against the household's own checking/savings accounts for
//      the exact opposite-signed amount — the same cross-account leg
//      matchDepositoryDebtPaymentLegs pairs for a live sync batch, just
//      re-run here for a leg that already went stale before that pairing ever
//      got a chance to run (real report, 2026-09-09: a stale $140.80 "Credit
//      Card Payment" phantom on a Sam's Club card whose real withdrawal,
//      correctly linked to a DebtPayment, already existed on checking).
// That migration only ever happens when exactly one candidate turns up and
// its own classification doesn't actively disagree with the phantom's — 0
// candidates, more than 1 (two genuinely separate real charges at the same
// merchant for a similar amount, say), or a real conflict (the phantom and
// its apparent twin already got auto-filed into two different buckets)
// means "don't guess which one this was," same convention as
// matchInternalTransfers / findUniqueDebtByMinPayment — but the phantom row
// itself is still gone either way; only the data-carryover is skipped.
//
// An offset or a debt-amount review is a real exception — deleting the row
// would destroy an actual relational link with no single obvious place to
// move it, so those are left for a human regardless of how stale they are.
// A linked receipt, a reimbursement pointed at this row (reimbursedBy), and
// an "already accounted for" pointer from another payment
// (accountedForByLinks) are handled instead, not just left alone: each is
// a plain nullable/joined pointer with one well-defined safe destination — the same
// confident single twin above — so it moves there when the twin doesn't
// already have a conflicting one of its own; otherwise (no twin, or the
// twin's already claimed/set) that link has nowhere safe to go and the
// whole row is left alone too.
//
// Deleting without a confident twin is safe for the same reason deleting
// *with* one always was: the sync upsert above is keyed on
// simpleFinTransactionId, so if this exact id ever legitimately reappears in
// a later feed (a transient one-off miss, not a real supersession — the
// whole reason STALE_PENDING_GRACE_MS exists), it just gets recreated as a
// fresh row with the same data, not silently lost.
//
// Shorter than that account-level grace period (2h), on purpose — a
// missing *account* is a murky signal (could be a real connectivity issue
// with the whole institution, as Sam's Club actually was), but one pending
// *transaction* going quiet while its account and every sibling transaction
// keep syncing fine in the same sync is a much stronger "this one really
// got superseded" signal, not a partial-response fluke. Even if it is a
// one-off miss, the failure mode is mild and self-correcting — the row just
// gets recreated (a new phantom, same data) if the same simpleFinTransactionId
// genuinely reappears later, not silent data loss. Two missed sync cycles
// (~20 min each) is already a real repeat-confirmation, not acting on the
// very first miss.
const STALE_PENDING_GRACE_MS = 60 * 60 * 1000;
const PENDING_POST_WINDOW_BEFORE_MS = 5 * 24 * 60 * 60 * 1000;
const PENDING_POST_WINDOW_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
const TIP_TOLERANCE_MAX_RATIO = 1.25;
const TIP_TOLERANCE_CAP_CENTS = 2000;
// How long a receipt-bearing phantom with no usable twin waits before its
// receipt is released back to matchReceipts instead of pinning the row. Long
// enough for a slow issuer to post the real charge (the twin path above then
// carries the receipt over itself); short enough that a voided hold or a
// split-shipment Amazon order doesn't sit in the ledger forever.
const ORPHAN_RECEIPT_RELEASE_MS = 7 * 24 * 60 * 60 * 1000;

//
// The grace period is skipped when this sync itself dropped the row and
// brought in its one confident twin (see pendingRowRetirable) — otherwise the
// hold and its posted charge both counted through this sync's categorization
// and bucket alerts. `syncStartedAt` is null outside a sync (no such signal).
async function reconcileStalePendingRows(householdId: string, syncStartedAt: Date | null): Promise<void> {
  const graceCutoff = new Date(Date.now() - STALE_PENDING_GRACE_MS);
  const stale = await db.transaction.findMany({
    where: {
      householdId,
      pending: true,
      updatedAt: { lt: syncStartedAt && syncStartedAt > graceCutoff ? syncStartedAt : graceCutoff },
    },
    include: {
      _count: { select: { offsetsAsCredit: true, offsetsAsDebit: true, accountedForByLinks: true } },
      reimbursedBy: { select: { id: true } },
      debtAmountReview: { select: { id: true } },
      receipt: { select: { id: true } },
      account: { select: { accountType: true } },
    },
  });

  for (const p of stale) {
    if (!p.accountId) continue;
    // An offset or a pending debt-amount review has no single obvious place
    // to move to — deleting the row would lose a real link, so those keep
    // being left for a human outright. A linked receipt is handled further
    // down instead: unlike these, it has one well-defined safe destination
    // (the twin below, if it doesn't already have its own) rather than
    // nowhere. A reimbursement pointed AT this phantom (reimbursedBy) or an
    // "already accounted for" pointer FROM another payment
    // (accountedForByLinks) turn out to be the same shape as a receipt, not
    // an offset: real report, 2026-09-24 — a household re-linked a posted
    // Verizon charge to the bill, but the stale pending hold it superseded
    // still carried the household's own reimbursement link, so this pass
    // refused to retire it and the bill showed the same payment twice, one
    // "extra." Both FKs are plain nullable pointers (no unique constraint),
    // so once a confident twin turns up below, re-pointing them there is
    // exactly as safe as migrating billId/bucketId onto it — see the twin
    // check further down. Only bail here on the two that truly have nowhere
    // to go regardless of a twin.
    if (p._count.offsetsAsCredit > 0 || p._count.offsetsAsDebit > 0 || p.debtAmountReview) continue;

    // Same-account twin, exact amount first — a high-volume, generically-
    // named merchant (Amazon: dozens of same-priced small per-item charges
    // a month, every pending row reading just "AMAZON MARKETPLACE" with no
    // per-order reference the way the posted side gets) routinely has
    // *other*, unrelated purchases sitting within the tip/adjustment
    // tolerance band below — checking that band up front turned an
    // otherwise-unique exact-amount match ambiguous by roping in charges
    // that just happen to cost similarly, not the same real purchase (real
    // finding, 2026-09-12 code review). Only widen to the tolerance band
    // (never lower — a posted charge only grows from its pending hold,
    // never shrinks) when the exact search itself comes up empty — that's
    // what the band exists for (a tip/adjustment added after the hold), not
    // as the default search.
    const window = {
      gte: new Date(p.createdAt.getTime() - PENDING_POST_WINDOW_BEFORE_MS),
      lte: new Date(p.createdAt.getTime() + PENDING_POST_WINDOW_AFTER_MS),
    };
    const pendingName = stripPendingPrefix(p.merchant);
    const nameMatches = (c: { merchant: string; rawDescription: string | null }) =>
      nameSimilarity(pendingName, c.merchant) >= 0.8 ||
      (p.rawDescription != null && nameSimilarity(stripPendingPrefix(p.rawDescription), c.merchant) >= 0.8) ||
      (p.rawDescription != null && c.rawDescription != null && nameSimilarity(p.rawDescription, c.rawDescription) >= 0.8);

    const exactCandidates = await db.transaction.findMany({
      where: {
        householdId,
        accountId: p.accountId,
        amountCents: p.amountCents,
        pending: false,
        id: { not: p.id },
        occurredOn: window,
        createdAt: { gt: p.createdAt },
      },
      include: { receipt: { select: { id: true } } },
    });
    let matches = exactCandidates.filter(nameMatches);

    if (matches.length === 0 && p.amountCents > 0) {
      const amountMax = Math.min(Math.round(p.amountCents * TIP_TOLERANCE_MAX_RATIO), p.amountCents + TIP_TOLERANCE_CAP_CENTS);
      const toleranceCandidates = await db.transaction.findMany({
        where: {
          householdId,
          accountId: p.accountId,
          amountCents: { gt: p.amountCents, lte: amountMax },
          pending: false,
          id: { not: p.id },
          occurredOn: window,
          createdAt: { gt: p.createdAt },
        },
        include: { receipt: { select: { id: true } } },
      });
      matches = toleranceCandidates.filter(nameMatches);
    }

    // Cross-account leg: a payment-shaped phantom sitting on the card's own
    // account whose real leg is the opposite-signed withdrawal on checking/
    // savings — the live-sync pairing (matchDepositoryDebtPaymentLegs) never
    // got a chance to run against it because it went stale first.
    if (
      matches.length === 0 &&
      p.account?.accountType === "CREDIT_CARD" &&
      (CARD_PAYMENT_MERCHANT_PATTERN.test(p.merchant) ||
        (p.rawDescription != null && CARD_PAYMENT_MERCHANT_PATTERN.test(p.rawDescription)))
    ) {
      matches = await db.transaction.findMany({
        where: {
          householdId,
          amountCents: -p.amountCents,
          pending: false,
          account: { accountType: { in: ["CHECKING", "SAVINGS"] } },
          occurredOn: {
            gte: new Date(p.createdAt.getTime() - TWIN_LOOKUP_WINDOW_MS),
            lte: new Date(p.createdAt.getTime() + TWIN_LOOKUP_WINDOW_MS),
          },
        },
        include: { receipt: { select: { id: true } } },
      });
    }

    // A confident single twin always supersedes the phantom and inherits
    // whatever classification it doesn't already have (see
    // phantomTwinMergeData for who wins a disagreement). No twin, or an
    // ambiguous multi-match, just means nothing to migrate — the phantom
    // still gets deleted on its own below.
    const twin = matches.length === 1 ? matches[0] : null;
    if (
      !pendingRowRetirable({
        pendingUpdatedAt: p.updatedAt,
        twinUpdatedAt: twin?.updatedAt ?? null,
        syncStartedAt,
        graceCutoff,
      })
    ) {
      continue;
    }
    if (
      settleOrphanPendingInPlace({
        hasTwin: twin != null,
        accountedForLinks: p._count.accountedForByLinks,
        pendingUpdatedAt: p.updatedAt,
        orphanCutoff: new Date(Date.now() - ORPHAN_RECEIPT_RELEASE_MS),
      })
    ) {
      await db.transaction.update({ where: { id: p.id }, data: { pending: false } });
      continue;
    }
    const data = twin ? phantomTwinMergeData(p, twin) : {};

    // A matched receipt is real data too, but unlike the scalar fields above
    // it can't be silently dropped OR silently reassigned — Receipt.
    // transactionId is @unique, so it only has one safe destination: the
    // very twin found above, and only if that twin doesn't already have a
    // receipt of its own (a household's order-confirmation email routinely
    // matches both the pending placeholder and the real posted row
    // independently via matchReceipts, so this isn't hypothetical — it's
    // exactly what was keeping several genuine duplicates stuck, 2026-09-24
    // finding). If the twin already has one, the phantom's is released back
    // to UNMATCHED — matchReceipts then places it on its real charge, parks
    // it AMBIGUOUS for review, or retires it as a duplicate. With no twin the
    // receipt has nowhere to go yet, so the row waits while the real charge
    // may still post — but only ORPHAN_RECEIPT_RELEASE_MS: nothing in the UI
    // can retire a phantom, so "leave it for a human" meant forever (real
    // report, 2026-09-30: two Amazon holds sat pending 9+ days), then the
    // receipt is released the same way.
    const releaseReceipt =
      p.receipt != null &&
      (twin ? twin.receipt != null : p.updatedAt.getTime() < Date.now() - ORPHAN_RECEIPT_RELEASE_MS);
    if (p.receipt && !twin && !releaseReceipt) continue;
    // No confident twin: same as a receipt, these have nowhere safe to go —
    // leave the whole row for a human rather than deleting a real link out
    // from under it.
    if (!twin && (p.reimbursedBy.length > 0 || p._count.accountedForByLinks > 0)) continue;

    await db.$transaction([
      ...(twin && Object.keys(data).length > 0 ? [db.transaction.update({ where: { id: twin.id }, data })] : []),
      ...(p.receipt && twin && !releaseReceipt ? [db.receipt.update({ where: { id: p.receipt.id }, data: { transactionId: twin.id } })] : []),
      ...(p.receipt && releaseReceipt
        ? [db.receipt.update({ where: { id: p.receipt.id }, data: { transactionId: null, matchState: "UNMATCHED" } })]
        : []),
      ...(twin && p.reimbursedBy.length > 0
        ? [
            db.transaction.updateMany({
              where: { id: { in: p.reimbursedBy.map((r) => r.id) } },
              data: { reimbursesTransactionId: twin.id },
            }),
          ]
        : []),
      ...(twin && p._count.accountedForByLinks > 0
        ? [db.debtPaymentAccountedFor.updateMany({ where: { purchaseTransactionId: p.id }, data: { purchaseTransactionId: twin.id } })]
        : []),
      db.transaction.delete({ where: { id: p.id } }),
    ]);
  }
}

// A negative amount on a CREDIT_CARD/LOAN account's *own* feed usually means
// a payment reducing what's owed — but confirmed 2026-08-14 that some
// institutions (Capital One, Chase, Sam's Club/Synchrony in this household's
// data) report ordinary purchases with that exact same negative sign right
// alongside real payments ("Automatic Payment", "Credit Card Payment"), so
// sign alone can't tell them apart there. Merchant text is the only
// remaining signal — see isLiabilityAccount below. Deliberately does NOT
// also check the card's own issuer name against the merchant text (a
// tempting way to catch a bare "Capital One" issuer-initiated payment
// posting) — tried that, and it backfires hard for a store-co-branded card
// (Sam's Club Mastercard): real purchases AT Sam's Club post with merchant
// text that's just "Sam's Club", identical to the card's own orgName, so
// that check would've kept real grocery-run purchases hidden as fake
// transfers. A missed bare-issuer-name payment (falls through as ordinary
// spend, sits reviewable in "Uncategorized" instead) is a far cheaper
// mistake than a hidden purchase (silently excluded from every bucket,
// nothing left to ever surface it) — so when unsure, this errs toward
// releasing, not keeping. Split into its own module (debt-payment-pattern.ts)
// so the reclassify dropdown can reuse it client-side too.

// Unlike the liability-account side (debtByAccountId — that transaction
// happens ON the debt's own account, so the link is direct), a checking-
// side "Transfer to Loan" or "Capital One Credit Card Payment" line gives
// no account-level link at all — SimpleFIN never says which account a
// transfer's money actually went to, and the merchant text is often too
// generic to name the specific lender (real incident: this household has
// two Capital One cards, so "Capital One Credit Card Payment" alone can't
// say which one). The household's own minPaymentCents doubles as a
// reliable fingerprint for the ones that AREN'T ambiguous — same "leave
// ambiguous unmatched rather than guessed" philosophy as matchBillPayments'
// tie-break, just applied here as a refusal instead of a tie-break: zero or
// multiple debts within tolerance means don't guess.
const MIN_PAYMENT_MATCH_TOLERANCE_CENTS = 300;

function findUniqueDebtByMinPayment(
  candidates: { id: string; minPaymentCents: number }[],
  amountCents: number,
): string | null {
  const matches = candidates.filter((d) => Math.abs(d.minPaymentCents - amountCents) <= MIN_PAYMENT_MATCH_TOLERANCE_CENTS);
  return matches.length === 1 ? matches[0].id : null;
}

// Last-resort attribution for a checking-side payment whose merchant text is
// a generic issuer descriptor (isGenericCardPaymentDescriptor — "Capital One
// Credit Card Payment") that names no specific card, and whose amount didn't
// uniquely fingerprint one debt by minimum payment either. The one signal
// left that's actually trustworthy: the offsetting credit posted to a
// specific tracked card/loan's OWN synced feed — a real balance reduction on
// that exact account. Attribute to the card that has it; return null (leave
// the payment isTransfer:true / debtId:null — a visible "needs review", not a
// guess) when zero or more than one tracked liability account does. Same
// two-legged shape matchDepositoryDebtPaymentLegs pairs for loans, but
// invoked only for the ambiguous-descriptor case rather than up front over
// the whole pool — a card feed routinely carries negative purchase refunds
// that look like a payment leg, so the leg must also read as a payment
// (CARD_PAYMENT_MERCHANT_PATTERN) before it counts.
//
// lenderName: when the caller already knows which card issuer this debit
// belongs to (because the checking-side merchant text IS the issuer name —
// e.g. "Capital One" matching a Quicksilver debt's accountOrgName), a
// card-side leg whose merchant also contains that lender name is accepted as
// payment evidence even if it carries no "payment" / "autopay" token. An
// issuer-initiated closing payment on the card's own feed routinely posts as
// a bare issuer name ("Capital One", not "Capital One Credit Card Payment")
// — the same name the checking-side debit uses — so CARD_PAYMENT_MERCHANT_
// PATTERN alone misses it. The combination of (1) a checking-side debit
// named after a specific issuer + (2) a same-amount, in-window credit on
// that issuer's own tracked account also named after the issuer is a strong
// two-legged signal (real payoff case, 2026-09-05: Quicksilver's $37.72
// closing payment sat unclassified because both legs read as bare
// "Capital One" with no payment token on either side).
async function findDebtByOffsettingCardLeg(
  householdId: string,
  debit: { amountCents: number; occurredOn: Date },
  debtByAccountId: Map<string, string>,
  // Widen from the default ±2 days when the caller already has a strong
  // independent signal that this debit is a payment (a name match on a
  // tracked debt, or an ACH payment descriptor) — the card→checking
  // settlement lag routinely runs past 2 days.
  windowMs: number = INTERNAL_TRANSFER_WINDOW_MS,
  lenderName?: string,
): Promise<string | null> {
  if (debtByAccountId.size === 0 || debit.amountCents <= 0) return null;
  const legs = await db.transaction.findMany({
    where: {
      householdId,
      accountId: { in: [...debtByAccountId.keys()] },
      account: { accountType: { in: ["CREDIT_CARD", "LOAN"] } },
      amountCents: -debit.amountCents,
      occurredOn: {
        gte: new Date(debit.occurredOn.getTime() - windowMs),
        lte: new Date(debit.occurredOn.getTime() + windowMs),
      },
    },
    select: { merchant: true, accountId: true, rawDescription: true },
  });
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lenderNorm = lenderName ? normalize(lenderName) : null;
  const debtIds = new Set(
    legs
      .filter(
        (l) =>
          CARD_PAYMENT_MERCHANT_PATTERN.test(l.merchant) ||
          isCardPaymentDescriptor(l.rawDescription) ||
          // The lender posts the closing credit with its own bare name (no
          // payment token) — accept it when the caller already confirmed this
          // debit is for this specific issuer via a name match.
          (lenderNorm != null &&
            lenderNorm.length >= 4 &&
            normalize(l.merchant).includes(lenderNorm)),
      )
      .map((l) => debtByAccountId.get(l.accountId!))
      .filter((id): id is string => Boolean(id)),
  );
  return debtIds.size === 1 ? [...debtIds][0] : null;
}

type CoBrandedDebt = {
  id: string;
  name: string;
  accountId: string | null;
  debtType: DebtType;
  bnplKeyword: string | null;
  account: { orgName: string | null } | null;
};

// Is this positive depository debit a co-branded card payment, and toward
// which tracked debt? A co-branded card (Sam's Club Mastercard) posts its
// checking-side payment with the payee cleaned down to just the store name,
// so it never matches CARD_PAYMENT_MERCHANT_PATTERN / DEBT_PAYMENT_TEXT_PATTERN
// and lands in Groceries. Resolution needs BOTH:
//   1. the txn text names at least one tracked non-BNPL debt (txnTextNamesDebt
//      — cleaned merchant vs. debt name, raw line vs. the account org name);
//   2. payment evidence — an ACH payment descriptor on the raw line
//      (isCardPaymentDescriptor, works on the first sync) OR an offsetting
//      credit on that card's own feed within the twin window.
// A name match alone is never enough: a genuine debit-card grocery run at the
// same store would match (1) but not (2). Shared by the categorizer branch
// and reconcileCategorizedCardPayments below.
//
// Multi-card-same-issuer: a household with Quicksilver + Venture + Discover
// (all orgName "Capital One") gets nameMatched.length = 3 for a bare "Capital
// One" payment — the single-match guard refuses to pick one. But if exactly
// one of those cards has an offsetting -$37.72 credit on its own feed, that
// IS the payment evidence; use findDebtByOffsettingCardLeg across all
// candidate accounts to pick the right card. Real incident 2026-09-09.
async function resolveCoBrandedCardPayment(
  householdId: string,
  t: {
    id: string;
    merchant: string;
    rawDescription: string | null;
    amountCents: number;
    occurredOn: Date;
    account: { accountType: AccountType } | null;
  },
  debts: CoBrandedDebt[],
  bnplKeywords: string[],
): Promise<string | null> {
  if (t.amountCents <= 0) return null;
  if (t.account?.accountType !== "CHECKING" && t.account?.accountType !== "SAVINGS") return null;

  const nameMatched = debts.filter(
    (d) =>
      d.debtType !== "INSTALLMENT" &&
      !resolveBnplKeyword(d, bnplKeywords) &&
      txnTextNamesDebt(
        { merchant: t.merchant, rawDescription: t.rawDescription },
        { name: d.name, accountOrgName: d.account?.orgName },
      ),
  );
  if (nameMatched.length === 0) return null;

  // When the txn text names exactly one debt, require payment evidence
  // (ACH descriptor or offsetting leg) — a name match alone can't rule out
  // a real purchase at the same merchant.
  if (nameMatched.length === 1) {
    const d = nameMatched[0];
    // Pass the debt's orgName so findDebtByOffsettingCardLeg can also accept
    // a card-side leg whose merchant is the bare lender name (no payment
    // token) — the case that left the Quicksilver payoff unclassified
    // (2026-09-05).
    const hasEvidence =
      isCardPaymentDescriptor(t.rawDescription) ||
      (d.accountId != null &&
        (await findDebtByOffsettingCardLeg(
          householdId,
          t,
          new Map([[d.accountId, d.id]]),
          TWIN_LOOKUP_WINDOW_MS,
          d.account?.orgName ?? undefined,
        )) === d.id);
    return hasEvidence ? d.id : null;
  }

  // Multiple debts share the same issuer name (e.g., three Capital One cards).
  // The name match is ambiguous on its own — use the offsetting card leg to
  // pick the specific card that actually received this payment. Build a single
  // accountId→debtId map across all matched accounts and let
  // findDebtByOffsettingCardLeg return the one unambiguous winner (or null if
  // zero or >1 accounts have a matching leg).
  const accountedCandidates = nameMatched.filter((d) => d.accountId != null);
  if (accountedCandidates.length === 0) return null;
  const accountMap = new Map(accountedCandidates.map((d) => [d.accountId!, d.id]));
  // All matched debts share the same orgName by definition of txnTextNamesDebt
  // — pass it so bare-lender-name card legs are accepted (same reason as above).
  const lenderName = nameMatched[0].account?.orgName ?? undefined;
  return findDebtByOffsettingCardLeg(householdId, t, accountMap, TWIN_LOOKUP_WINDOW_MS, lenderName);
}

// Self-heal: retire any base (unbounded) debt-targeted MerchantRule keyed on
// a generic issuer payment descriptor. Reassigning one such transaction to a
// debt used to write exactly this kind of rule (buckets/actions.ts), which
// then misfiled every same-issuer payment — including an untracked spouse's
// card's — onto that one debt on every later sync (real incident,
// 2026-09-01). These payments are now attributed per-transaction instead
// (unique minimum-payment match, or an offsetting card-side leg), so the
// blanket rule only does harm. Bucket-targeted rules on the same text are
// left alone — a household that files its card payments into a bucket on
// purpose still gets that.
async function dropGenericCardPaymentDebtRules(householdId: string): Promise<void> {
  const rules = await db.merchantRule.findMany({
    where: { householdId, debtId: { not: null }, amountMinCents: null, amountMaxCents: null },
    select: { id: true, merchant: true },
  });
  const stale = rules.filter((r) => isGenericCardPaymentDescriptor(r.merchant)).map((r) => r.id);
  if (stale.length === 0) return;
  await db.merchantRule.deleteMany({ where: { id: { in: stale } } });
}

// Self-heal: retire any base (unbounded) MerchantRule keyed on nothing more
// than a bare BNPL provider name ("affirm", "klarna", …). That text is
// ambiguous across every plan at the provider — tracked or not — so a
// blanket rule committing it to a spend bucket shadows the per-installment
// attribution of a tracked plan on every later sync (real incident,
// 2026-09-02: an AI-written "affirm" -> Retail / Shopping rule, born from a
// second, *untracked* Affirm plan's ~$27 charges, kept a tracked plan's own
// $17.42 biweekly installment out of the plan for weeks — the BNPL branch in
// categorizeUncategorizedTransactions never ran because the rule matched
// first). Same precedent as dropGenericCardPaymentDebtRules above: an
// inherently ambiguous descriptor is attributed per-transaction (the BNPL
// branch when a tracked plan's amount qualifies, an ordinary AI guess
// otherwise — which no longer writes a rule for a bare provider name, see
// runOrdinaryAiSuggestions), never by a household-wide rule. Amount-bounded
// overrides are left alone — those name a specific plan's payment amount.
async function dropAmbiguousBnplMerchantRules(householdId: string, bnplKeywords: string[]): Promise<void> {
  const rules = await db.merchantRule.findMany({
    where: { householdId, amountMinCents: null, amountMaxCents: null },
    select: { id: true, merchant: true },
  });
  const stale = rules.filter((r) => bnplKeywords.includes(r.merchant.trim().toLowerCase())).map((r) => r.id);
  if (stale.length === 0) return;
  await db.merchantRule.deleteMany({ where: { id: { in: stale } } });
}

// Sweeps every currently-uncategorized transaction for the household
// (not just what this sync run touched), so a transaction that was skipped
// or never processed — e.g. the entire historical backlog from before this
// feature existed — self-heals on the next sync instead of staying stuck
// forever. Passes, cheapest and most-trusted first:
// (1) MerchantRule — a household-wide, indexed cache of every merchant this
//     household has ever resolved (by a human OR by AI, even a low-confidence
//     AI guess), so a merchant only ever gets sent to Gemini once, ever, no
//     matter how many more transactions from it show up later.
// (2) explicit "transfer" wording — checked before any sign-based guessing,
//     both directions, so "Transfer from Venmo" (money in) is recognized
//     the same way "Transfer to Loan" (money out) is, instead of falling
//     through to a blind income guess.
// (3) money-in with no rule/transfer match: a refund of a merchant this
//     household has spent at before is filed back into that spend history
//     (queued the same as any other transaction) rather than assumed to be
//     income; only genuinely unexplained money-in defaults to income.
// (4) known BNPL keyword matches for an already-tracked installment debt.
// (5) whatever's left goes to Gemini in batches; every result — auto-filed
//     or not — gets written into MerchantRule so it's never asked again.
//     (There used to be a step here that auto-filed anything repeating on a
//     ~30-day cadence straight into "Subscriptions" with no semantic check —
//     removed 2026-08-10 after it turned out to fire on mortgage payments,
//     utility bills, and insurance premiums just as readily as real
//     subscriptions, since cadence alone can't tell them apart. Gemini can:
//     it sees the actual bucket list and merchant name, so a recurring
//     monthly charge now gets asked like anything else instead of being
//     rubber-stamped into the wrong bucket.)
// Self-heal (2026-08-14): releases any CREDIT_CARD/LOAN-side transaction
// that was previously misfiled as a transfer (isTransfer:true) back into
// the normal categorization pool, if it no longer looks like a payment
// under CARD_PAYMENT_MERCHANT_PATTERN (see that constant's comment) — a
// household's synced history that predates this heuristic can have real
// purchases sitting there wrongly excluded from every bucket, indefinitely,
// with nothing else to ever revisit them (categorizeUncategorizedTransactions'
// own candidate query only ever looks at isTransfer:false rows). Never
// touches a transaction already linked to a real DebtPayment
// (debtPaymentId set) — that one really was confirmed as a payment by the
// matching engine, not just guessed at sync time.
async function reclassifyMisfiledCardTransfers(householdId: string): Promise<void> {
  const suspects = await db.transaction.findMany({
    where: {
      householdId,
      isTransfer: true,
      debtId: { not: null },
      debtPaymentId: null,
      account: { accountType: { in: ["CREDIT_CARD", "LOAN"] } },
    },
    select: { id: true, merchant: true },
  });
  const toRelease = suspects.filter((t) => !CARD_PAYMENT_MERCHANT_PATTERN.test(t.merchant));
  if (toRelease.length === 0) return;
  await db.transaction.updateMany({
    where: { id: { in: toRelease.map((t) => t.id) } },
    data: { isTransfer: false, debtId: null },
  });
}

export async function categorizeUncategorizedTransactions(householdId: string): Promise<void> {
  await reclassifyMisfiledCardTransfers(householdId);
  await dropGenericCardPaymentDebtRules(householdId);

  // Static list plus whatever this household's own AI connection has
  // confirmed (BnplKeyword, see checkForNewBnplLenders/allBnplKeywords,
  // src/lib/bnpl-detect.ts) — used everywhere below that used to reference
  // the bare static BNPL_KEYWORDS, so a discovered lender is recognized here
  // exactly like a hardcoded one.
  const bnplKeywords = await allBnplKeywords(householdId);
  await dropAmbiguousBnplMerchantRules(householdId, bnplKeywords);

  const [buckets, debts, bnplDebtPayments, rules, patterns, categories, candidates] = await Promise.all([
    db.bucket.findMany({
      // A retired one-time bucket never takes a new charge (auto-file, AI
      // suggestion, or one-time match) — see Bucket.retiredAt.
      where: { householdId, retiredAt: null },
      select: {
        id: true,
        name: true,
        trackingMode: true,
        aiInstructions: true,
        excludedFromAllocation: true,
        monthlyCapCents: true,
      },
    }),
    db.debt.findMany({
      where: { householdId },
      select: {
        id: true,
        name: true,
        accountId: true,
        minPaymentCents: true,
        kind: true,
        debtType: true,
        bnplKeyword: true,
        account: { select: { orgName: true } },
      },
    }),
    // Only needed for resolveBnplDebtId's same-amount tie-break below — a
    // plain amount filter also happens to catch every REVOLVING debt (no
    // DebtPayment they'd match by name anyway), so this stays scoped to
    // INSTALLMENT rather than joining DebtPayment onto every debt above.
    db.debtPayment.findMany({
      where: { householdId, debt: { debtType: "INSTALLMENT" } },
      select: { debtId: true, nextDueDate: true },
    }),
    db.merchantRule.findMany({ where: { householdId } }),
    // cadence: null — a scheduled pattern is matched by matchPatternPayments'
    // own cycle-aware walk instead (see reassignTransactionsForPattern's
    // matching comment, pattern-reassign.ts, for the full reasoning).
    db.recurringPattern.findMany({ where: { householdId, active: true, cadence: null } }),
    db.billCategory.findMany({ where: { householdId }, select: { id: true, name: true, bucketId: true } }),
    db.transaction.findMany({
      where: {
        householdId,
        bucketId: null,
        isIncome: false,
        isTransfer: false,
        oneOff: false,
        // A transaction this old can't affect the current month's bucket
        // totals or reports anyway (see "Needs a bucket" queue, which
        // applies the same cutoff) — no reason to spend a Gemini call
        // resolving it. It stays uncategorized rather than guessed at.
        occurredOn: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
      },
      select: {
        id: true,
        merchant: true,
        // The untouched bank line — SimpleFIN's `payee` normalisation strips a
        // co-branded card payment down to just the store name, but the raw ACH
        // descriptor keeps the payment tell (see isCardPaymentDescriptor).
        rawDescription: true,
        // Set once a receipt email is matched (matchReceipts, receipt-sync.ts)
        // — the real party behind an opaque "Venmo"/"SQ *…" charge. When
        // present it's used as the merchant key below, so a P2P charge with
        // a known counterparty is categorized and learned exactly like an
        // ordinary merchant instead of going down the suggest-only P2P path.
        resolvedMerchant: true,
        // A person (friend/family P2P) stays suggest-only; only a business
        // party becomes an ordinary learnable merchant.
        resolvedMerchantIsPerson: true,
        // The payment memo off a matched receipt — the strongest per-payment
        // signal for the P2P categorization pass (see runP2PAiSuggestions).
        receiptNote: true,
        amountCents: true,
        occurredOn: true,
        accountId: true,
        label: true,
        notes: true,
        aiSuggestedBucketId: true,
        aiSuggestedCategoryId: true,
        pending: true,
        account: { select: { accountType: true, budgetTracked: true } },
      },
    }),
  ]);
  if (candidates.length === 0) return;

  // A RECURRING bucket ("bills and subscriptions are always recurring")
  // must never receive a silently auto-filed transaction — not from a
  // MerchantRule (even a USER-confirmed one; the bucket's mode may have
  // been set *after* the rule was created) and not from a fresh AI guess,
  // no matter how confident. Either kind still lands as an
  // aiSuggestedBucketId *hint* (surfaced in the "needs a bucket" queue) or,
  // once a real pattern emerges, as a bill suggestion to accept instead —
  // just never a committed bucketId a human never confirmed. MIXED buckets
  // are different: they legitimately hold genuine one-off spend alongside a
  // recurring fee (e.g. "Kids Activities" — a one-off event ticket plus a
  // recurring dance-class charge), so the one-off portion auto-files
  // exactly like SPEND; only RECURRING blocks auto-commit outright. The
  // recurring portion of a MIXED bucket still becomes a tracked
  // RecurringBill via the normal suggestion flow (bill-detect.ts groups by
  // merchant regardless of bucketId), independent of this gate. A direct
  // manual assignment (reassignTransaction, the "needs a bucket" queue's
  // own "Assign" button) is a deliberate in-the-moment human choice and is
  // deliberately NOT gated by this — only the automatic sync pipeline is.
  const autoAssignableBucketIds = new Set(buckets.filter((b) => b.trackingMode !== "RECURRING").map((b) => b.id));
  // See matchOneTimeBucket's own comment — these never get a MerchantRule,
  // so they're matched by amount + name directly instead.
  const oneTimeBuckets = buckets.filter((b) => b.excludedFromAllocation);
  // Every rule for a merchant, not just one — a merchant can carry a base
  // rule plus one or more amount-bounded overrides (pickMerchantRule picks
  // the one that fits each transaction's amount).
  const rulesByMerchant = new Map<string, typeof rules>();
  for (const r of rules) {
    const arr = rulesByMerchant.get(r.merchant) ?? [];
    arr.push(r);
    rulesByMerchant.set(r.merchant, arr);
  }
  const debtByAccountId = new Map(debts.filter((d) => d.accountId).map((d) => [d.accountId!, d.id]));
  // Same account, same lender name — see the isLiabilityAccount branch below.
  const debtLenderNameByAccountId = new Map(
    debts.filter((d) => d.accountId && d.account?.orgName).map((d) => [d.accountId!, d.account!.orgName!]),
  );
  // Only usable to attribute a bare "Transfer to Loan" when there's exactly
  // one — see LOAN_TRANSFER_TEXT_PATTERN.
  const loanDebts = debts.filter((d) => d.kind === "LOAN");
  // BNPL provider names are distinctive enough (unlike generic "Transfer to
  // Loan" text) to safely auto-attribute to a specific tracked debt once one
  // exists with a matching name — this is what lets a debt "adopt" the
  // transactions that led to it being suggested/tracked in the first place.
  // A provider can have more than one simultaneous plan tracked (e.g. two
  // separate Klarna purchases) — disambiguated below by nearest payment
  // amount within the normal bill-style tolerance, not just "the first debt
  // whose name matches," which used to silently misfile every later plan's
  // payments onto whichever same-provider debt was created first (real
  // gap, 2026-08-16, caught once a household had 2 real Klarna plans). This
  // is a looser first-pass attribution than matchInstallmentPayments'
  // actual (much tighter) payment-linking tolerance — its job is just
  // "which lender does this belong to" for bucket exclusion, not the final
  // cycle-by-cycle match.
  const nextDueDateByDebtId = new Map(bnplDebtPayments.map((p) => [p.debtId, p.nextDueDate]));
  const debtsByBnplKeyword = new Map<string, { id: string; minPaymentCents: number; nextDueDate: Date | null }[]>();
  for (const d of debts) {
    const keyword = resolveBnplKeyword(d, bnplKeywords);
    if (!keyword) continue;
    const arr = debtsByBnplKeyword.get(keyword) ?? [];
    arr.push({ id: d.id, minPaymentCents: d.minPaymentCents, nextDueDate: nextDueDateByDebtId.get(d.id) ?? null });
    debtsByBnplKeyword.set(keyword, arr);
  }
  // Left unresolved (isTransfer:true, no debtId) if no tracked plan's
  // amount is close enough — same "ambiguous -> leave for a human"
  // convention used elsewhere in this file, rather than guessing wrong.
  // Amount alone can't always pick a single winner — two simultaneous
  // plans at the same provider for the *same* price (real report,
  // 2026-08-16: two $50 Afterpay plans) tie every time. Break that tie by
  // whichever plan's own tracked schedule (DebtPayment.nextDueDate, which
  // already reflects its cadence + purchase date) sits closest to this
  // transaction's date — a plan with no tracker yet has no schedule to
  // compete with, and if every qualifying candidate is equally
  // schedule-less (or genuinely tied on distance), this stays unresolved
  // rather than guessing which of two identical-looking plans actually
  // owns it.
  function qualifyingBnplDebts(keyword: string, amountCents: number) {
    return (debtsByBnplKeyword.get(keyword) ?? []).filter(
      (c) => Math.abs(c.minPaymentCents - amountCents) <= bnplAttributionToleranceCents(c.minPaymentCents),
    );
  }

  function resolveBnplDebtId(keyword: string, amountCents: number, occurredOn: Date): string | null {
    const qualifying = qualifyingBnplDebts(keyword, amountCents);
    if (qualifying.length === 0) return null;
    if (qualifying.length === 1) return qualifying[0].id;

    const withSchedule = qualifying.filter((c) => c.nextDueDate !== null);
    if (withSchedule.length === 0) return null;
    // A genuine tie (two plans equally close — the same-day, same-amount
    // Afterpay case above) must actually fall through to "stays unresolved"
    // like the comment says, not silently default to whichever candidate
    // happens to be first in `debts`' own array order every time — a plain
    // `.reduce` picking the strictly-closer element does exactly that on an
    // exact tie (never replaces `best`), which would starve every plan but
    // the first of ever getting a single payment auto-matched. Left
    // isTransfer:true/debtId:null instead (see the caller below) —
    // matchInstallmentPayments' own per-debt sweep (src/lib/debt-payments.ts)
    // fairly claims one candidate per tracker per pass, which is all that
    // actually matters for two indistinguishable plans: it doesn't matter
    // *which* specific transaction lands on *which* specific plan, only that
    // the totals come out right.
    const distances = withSchedule.map((c) => Math.abs(c.nextDueDate!.getTime() - occurredOn.getTime()));
    const minDistance = Math.min(...distances);
    const closest = withSchedule.filter((_c, i) => distances[i] === minDistance);
    return closest.length === 1 ? closest[0].id : null;
  }
  // Candidates for amount-based matching below — excludes BNPL debts (those
  // are matched by name+amount via resolveBnplDebtId instead) and anything
  // with no minPaymentCents set (a $0 "match" against a $0 transaction would
  // be meaningless).
  const minPaymentCandidates = debts.filter(
    (d) => d.minPaymentCents > 0 && !resolveBnplKeyword(d, bnplKeywords),
  );

  const needsAi: { id: string; merchant: string; amountCents: number }[] = [];
  // P2P debits needing a bucket/category guess — collected separately from
  // needsAi above (see the isP2PMerchant branch below): P2P merchant text
  // has no per-merchant signal to batch on, so this goes through
  // suggestP2PClassifications instead of suggestBucketsForMerchants/
  // suggestCategoriesForMerchants, one call per transaction batch rather
  // than per unique merchant.
  const needsAiP2P: { id: string; merchant: string; party: string | null; receiptNote: string | null; amountCents: number; occurredOn: Date; label: string | null; notes: string | null }[] =
    [];

  // Runs first, over the whole pool: a real self-transfer is a stronger,
  // less ambiguous signal than anything below (a MerchantRule, a pattern,
  // AI) and must never be second-guessed by one of them — see
  // matchInternalTransfers' own comment above.
  const internallyMatched = await matchInternalTransfers(candidates);
  // Same up-front, whole-pool, never-second-guessed pass — for the
  // checking<->own-liability-account leg pairing (a debt payment / payoff),
  // not checking<->checking. See matchDepositoryDebtPaymentLegs' comment.
  const debtLegMatched = await matchDepositoryDebtPaymentLegs(householdId, candidates, debtByAccountId);

  for (const t of candidates) {
    if (internallyMatched.has(t.id) || debtLegMatched.has(t.id)) continue;
    // A receipt-resolved BUSINESS party ("Jane's Dog Walking") supersedes
    // the raw merchant text ("Venmo") everywhere below: the MerchantRule
    // key, the AI-suggestion batching, and the rule written on a human
    // confirm. A resolved PERSON ("Danny R") does not — a friend-to-friend
    // payment could be for anything, so it keeps the suggest-only P2P path
    // (the name is still shown and fed to the P2P model as a hint).
    const resolvedBusiness =
      t.resolvedMerchant && !t.resolvedMerchantIsPerson ? t.resolvedMerchant.trim() : null;
    const effectiveMerchant = resolvedBusiness || t.merchant;
    const key = effectiveMerchant.trim().toLowerCase();
    // See the schema comment on Account.budgetTracked — a manual entry has
    // no account at all, so it's always eligible (a household typed it in
    // themselves, on purpose).
    const budgetTracked = t.account ? t.account.budgetTracked : true;

    // Every P2P app shares the same generic merchant text ("Venmo",
    // "Zelle", "PayPal") across totally unrelated payments — checked before
    // both the pattern match above's fallback and the MerchantRule lookup
    // below, so a stale or otherwise-generic rule/pattern can never
    // silently re-inherit the old "always a transfer" behavior for a P2P
    // merchant (real incident: a household-confirmed "paypal" MerchantRule
    // from before this split existed kept forcing every new bare "PayPal"
    // transaction into isTransfer:true forever, since the rule-lookup below
    // had no P2P awareness of its own — see reassignTransaction,
    // src/app/buckets/actions.ts, for the write-side equivalent of this
    // guard). A P2P transaction only ever gets classified by a
    // household-authored RecurringPattern (checked above, which IS safe:
    // a pattern is scoped to a specific label + amount range/day, not a
    // bare merchant string) or by the dedicated P2P defaults below.
    // A P2P charge is treated as an ordinary merchant only once a matched
    // receipt has resolved it to a *business*. Unresolved, or resolved to a
    // person, it stays on the suggest-only P2P path.
    const isP2PMerchant =
      !resolvedBusiness && P2P_DISCOVERY_KEYWORDS.some((k) => t.merchant.toLowerCase().includes(k));

    // User-defined patterns (Venmo-paid activities, recurring reimbursements)
    // are the most specific signal available — checked before the generic
    // merchant cache, since a plain "venmo" MerchantRule would flatten every
    // distinct activity into one bucket instead of telling them apart.
    if (patterns.length > 0) {
      const match = matchRecurringPattern(patterns, t);
      if (match) {
        await db.transaction.update({ where: { id: t.id }, data: patternMatchData(match) });
        continue;
      }
    }

    // Money out of a depository account with "loan"/"mortgage"/"principal" in
    // the text, and exactly one tracked DebtKind.LOAN debt for it to mean —
    // attribute it and let matchDebtPayments do the actual cycle match
    // (including "way over the minimum -> paid off"). Not gated on amount (a
    // regular monthly payment and a lump-sum payoff should both land), and
    // ahead of the MerchantRule lookup so a stale low-confidence AI guess of
    // "Bills (recurring)" on the same generic text can't shadow it.
    if (
      !isP2PMerchant &&
      t.amountCents > 0 &&
      t.account?.accountType !== "CREDIT_CARD" &&
      t.account?.accountType !== "LOAN" &&
      loanDebts.length === 1 &&
      LOAN_TRANSFER_TEXT_PATTERN.test(t.merchant)
    ) {
      await db.transaction.update({
        where: { id: t.id },
        data: {
          isTransfer: true,
          debtId: loanDebts[0].id,
          bucketId: null,
          isIncome: false,
          aiSuggestedBucketId: null,
          aiSuggestedCategoryId: null,
        },
      });
      continue;
    }

    // A co-branded card payment out of checking (see resolveCoBrandedCardPayment)
    // — SimpleFIN cleans the merchant to the bare store name, so nothing above
    // catches it and it would fall into Groceries. Ahead of the MerchantRule
    // lookup for the same reason the loan branch is: a learned
    // "Sam's Club -> Groceries" rule must not shadow it.
    if (!isP2PMerchant) {
      const coBrandedDebtId = await resolveCoBrandedCardPayment(householdId, t, debts, bnplKeywords);
      if (coBrandedDebtId) {
        await db.transaction.update({
          where: { id: t.id },
          data: {
            isTransfer: true,
            debtId: coBrandedDebtId,
            bucketId: null,
            categoryId: null,
            isIncome: false,
            aiSuggestedBucketId: null,
            aiSuggestedCategoryId: null,
          },
        });
        continue;
      }
    }

    const pickedRule = !isP2PMerchant ? pickMerchantRule(rulesByMerchant.get(key) ?? [], t.amountCents) : undefined;
    // Whether the BNPL-attribution branch further down would fire for this
    // transaction — merchant text carries a provider keyword AND a tracked
    // installment plan's amount qualifies. Hoisted here so the rule lookup
    // can yield to it (below).
    //
    // RAW merchant text (t.merchant), not `key` — same convention
    // DEBT_PAYMENT_TEXT_PATTERN/CARD_PAYMENT_MERCHANT_PATTERN below already
    // use, and for the same reason: `key` prefers a receipt-resolved name,
    // which answers "what was purchased" (the retailer), not "who was
    // paid" (the lender) — the bank's own descriptor is the only ground
    // truth for which processor actually moved the money, and a resolved
    // retailer name can never carry a BNPL provider's keyword. Real report,
    // 2026-09-09: a Nike order-confirmation email receipt (matchReceipts,
    // earlier this same sync) had already resolved this transaction's
    // merchant from bare "Klarna" to "Nike" by the time this ran, so `key`
    // ("nike") carried no BNPL keyword at all and the charge fell through
    // to ordinary Retail/Shopping categorization instead of being
    // attributed to the Nike - Klarna installment plan — with no retry once
    // it had a bucket (categorizeUncategorizedTransactions only reconsiders
    // bucketId:null rows). The retailer name is still the right merchant
    // for every other branch below (rules/AI/one-time-bucket all keep using
    // `key`/`effectiveMerchant`) — only this identification check needs the
    // untouched bank text.
    const bnplKeyword = bnplKeywords.find((k) => t.merchant.toLowerCase().includes(k));
    const bnplBranchWouldFire =
      bnplKeyword !== undefined && qualifyingBnplDebts(bnplKeyword, t.amountCents).length > 0;
    // A generic issuer payment descriptor ("Capital One Credit Card Payment")
    // names no specific card — never let a blanket merchant rule attribute one
    // to a debt (dropGenericCardPaymentDebtRules retires these on sight, but a
    // rule created earlier this same run, or a bounded one, could still slip
    // through). It falls through to per-transaction attribution below instead.
    //
    // Same idea for a bare BNPL provider name: an AI-written blanket rule on
    // "affirm" / "klarna" is ambiguous across every plan at that provider and
    // must never pre-empt attributing an installment to the actual tracked
    // plan (real incident 2026-09-02: an "affirm" -> Retail / Shopping rule,
    // born from a *second, untracked* Affirm plan's charges, shadowed a
    // tracked plan's own $17.42 installment on every sync for weeks — the
    // BNPL branch below never got to run). dropAmbiguousBnplMerchantRules
    // retires these too, but a rule written earlier this same run could still
    // slip through; yield to the BNPL branch whenever it would fire.
    const rule =
      pickedRule && ((pickedRule.debtId && isGenericCardPaymentDescriptor(key)) || bnplBranchWouldFire)
        ? undefined
        : pickedRule;
    if (rule) {
      const bucketAutoAssignable = !rule.bucketId || (autoAssignableBucketIds.has(rule.bucketId) && budgetTracked);
      const bucketCommits = bucketAutoAssignable && (rule.source === "USER" || rule.confidence >= 0.7);
      // A category only ever travels with its bucket — Transaction.categoryId
      // must always point at a BillCategory scoped to Transaction.bucketId
      // (2026-08-27, household rule: "every transaction should belong to a
      // bucket and a category found within that bucket only"). So the
      // category rides exactly where the bucket does: committed only when the
      // bucket commits to that same bucket, hinted only alongside the bucket
      // hint. A rule whose stored category somehow isn't in its own bucket is
      // ignored for category entirely.
      const catInRuleBucket =
        Boolean(rule.categoryId) && categories.find((c) => c.id === rule.categoryId)?.bucketId === rule.bucketId;
      // `!t.pending` — a learned rule replaying as a mere *hint* is still a
      // suggestion, same as a fresh AI guess (see the pending guard on the
      // ordinary AI-guess pass below): a household shouldn't be nudged
      // toward "track this as a new bill" off a provisional pending charge,
      // even when the hint comes from a cached rule instead of a live
      // Gemini call. `bucketCommits` above is unaffected — an actual
      // auto-file is "applying to something already set up," which is fine
      // while pending (2026-09-22 household request).
      const bucketHint = !t.pending && !bucketCommits && Boolean(rule.bucketId) && !t.aiSuggestedBucketId;

      const bucketData = bucketCommits
        ? { bucketId: rule.bucketId, debtId: rule.debtId, isTransfer: rule.isTransfer, isIncome: rule.isIncome, aiSuggestedBucketId: null }
        : bucketHint
          ? // Either a low-confidence AI guess, or a rule pointing at a
            // RECURRING/MIXED bucket that must never auto-file — either
            // way, reuse it as the pre-fill instead of asking Gemini again,
            // but still leave it for a human to confirm rather than
            // silently auto-filing.
            { aiSuggestedBucketId: rule.bucketId }
          : {};
      const categoryData =
        bucketCommits && catInRuleBucket
          ? { categoryId: rule.categoryId, aiSuggestedCategoryId: null }
          : bucketHint && catInRuleBucket && !t.aiSuggestedCategoryId
            ? { aiSuggestedCategoryId: rule.categoryId }
            : {};
      const data = { ...bucketData, ...categoryData };
      if (Object.keys(data).length > 0) {
        await db.transaction.update({ where: { id: t.id }, data });
      }
      continue;
    }

    // A one-time-purchase bucket has no MerchantRule to fall back on (see
    // matchOneTimeBucket's own comment) — checked here, once no rule fired,
    // ahead of the generic debt/P2P defaults below, so a stray "contains
    // 'loan'" match or a minimum-payment coincidence can't shadow an actual
    // down payment.
    if (!isP2PMerchant && budgetTracked && t.amountCents > 0 && oneTimeBuckets.length > 0 && !t.aiSuggestedBucketId) {
      const match = matchOneTimeBucket(oneTimeBuckets, effectiveMerchant, t.amountCents);
      // A non-commit match is a hint — same "no suggestion while pending"
      // rule as everywhere else above; a commit (an already-eligible
      // one-time bucket auto-filing) still applies regardless.
      if (match && (match.commit || !t.pending)) {
        await db.transaction.update({
          where: { id: t.id },
          data: match.commit
            ? { bucketId: match.bucketId, categoryId: null, aiSuggestedBucketId: null }
            : { aiSuggestedBucketId: match.bucketId },
        });
        continue;
      }
    }

    // Excludes P2P merchant text — findUniqueDebtByMinPayment below has no
    // merchant signal to lean on, only a coincidental amount match against
    // some debt's minimum payment. A recurring P2P debit (weekly training,
    // $20-30) can easily collide with an unrelated debt's minimum by
    // chance, silently misfiling it as that debt's payment for the cycle.
    // P2P falls through to its own dedicated default below instead.
    if (!isP2PMerchant && DEBT_PAYMENT_TEXT_PATTERN.test(t.merchant)) {
      const debtId =
        t.amountCents < 0
          ? (debtByAccountId.get(t.accountId ?? "") ?? null)
          : (findUniqueDebtByMinPayment(
              scopeToNamedDebts(t, debts, minPaymentCandidates, (d) => ({
                name: d.name,
                accountOrgName: d.account?.orgName,
              })),
              t.amountCents,
            ) ??
            (await findDebtByOffsettingCardLeg(householdId, t, debtByAccountId)));
      await db.transaction.update({ where: { id: t.id }, data: { isTransfer: true, debtId } });
      continue;
    }

    // A P2P credit (Venmo/Zelle/PayPal money in) defaults straight to
    // unconfirmed income — the household confirms from there whether it's
    // a reimbursement (one-off or recurring, via ReimbursementLinker/
    // PatternPanel) or genuine recurring income (PatternPanel
    // countsAsIncome, or a tracked Income), same three-way choice
    // TransactionRow already offers. Deliberately skips the
    // hasSpendHistory refund check below: that heuristic exists for
    // ordinary merchants, where "we've spent here before" is a real signal
    // a credit is a refund — but every P2P app's merchant text is shared
    // across totally unrelated payments, so a household's own ordinary
    // PayPal *purchases* would otherwise wrongly suppress the income
    // default for a genuine PayPal *payment received*.
    if (isP2PMerchant && t.amountCents < 0) {
      await db.transaction.update({ where: { id: t.id }, data: { isIncome: true } });
      continue;
    }

    if (t.amountCents < 0) {
      // A credit on a credit card or loan account is usually a payment
      // reducing what's owed — money moving between the household's own
      // accounts, never real income. Sign alone is NOT enough, even on a
      // debt's own known liability account — that same feed's negative
      // entries also cover a cash-back/rewards redemption (real example:
      // "Cashback" -$2.94 on this same Quicksilver account) and a return
      // credit for a prior purchase (keeps the original retailer's name,
      // e.g. a "Nike" refund) — neither is a payment, and the household
      // explicitly doesn't want either counted as one (2026-09-06). What
      // actually distinguishes a real payment is the merchant text naming
      // the lender itself (CARD_PAYMENT_MERCHANT_PATTERN's tokens, or — when
      // we already know which Debt this account belongs to — the account's
      // own Account.orgName appearing in the merchant text, e.g. bare
      // "Capital One" for a Quicksilver closing payment that carried no
      // "payment"/"autopay"/"credit card" token for the pattern alone to
      // catch, and sat fully unclassified as a result, hiding a real payoff
      // from This Week's Bills, the Payment Calendar, and the payoff-plan
      // waterfall alike, 2026-09-05).
      const isLiabilityAccount =
        t.account?.accountType === "CREDIT_CARD" || t.account?.accountType === "LOAN";
      if (isLiabilityAccount) {
        const trackedDebtId = debtByAccountId.get(t.accountId ?? "");
        const lenderName = debtLenderNameByAccountId.get(t.accountId ?? "");
        const looksLikeLenderPayment =
          lenderName != null && t.merchant.toLowerCase().includes(lenderName.trim().toLowerCase());
        if (looksLikeLenderPayment || CARD_PAYMENT_MERCHANT_PATTERN.test(t.merchant)) {
          await db.transaction.update({
            where: { id: t.id },
            data: { isTransfer: true, debtId: trackedDebtId ?? null },
          });
          continue;
        }
      } else {
        // Before assuming a deposit is income: has this household ever spent
        // at this exact merchant? If so, it's almost certainly a refund
        // against that spend, not new income. tryAutoLinkRefund does that
        // check itself (and, when there's exactly one matching purchase for
        // the exact same amount, links this credit to it outright — see
        // Transaction.reimbursesTransactionId); "ambiguous" (2+ candidates,
        // e.g. one of several trips to the same store) still isn't income
        // either, it just waits in getUnmatchedRefunds for a human instead
        // of guessing which purchase it was. Either way, route it through
        // the normal bucket pipeline (below) instead of defaulting to income
        // — only genuinely no history at all falls back to that.
        const refundMatch = await tryAutoLinkRefund(householdId, {
          id: t.id,
          merchant: t.merchant,
          amountCents: t.amountCents,
          occurredOn: t.occurredOn,
        });
        // Same-merchant matching above can never find anything for a P2P
        // app or a card network's own dispute-resolution credit ("Visa
        // Chargeback Adjustment") — its merchant text never identifies the
        // real payee, so no purchase is ever literally named that. For
        // exactly that subset, fall back to an amount-only search across
        // every merchant before giving up and defaulting to income —
        // household request, 2026-09-27: that exact chargeback credit had a
        // same-amount purchase sitting right there and still got marked
        // income with no review, purely because "none" ended the search.
        const genericMatch =
          refundMatch === "none" && creditDoesNotIdentifyPayee(t.merchant)
            ? await tryAutoLinkGenericCredit(householdId, { id: t.id, amountCents: t.amountCents, occurredOn: t.occurredOn })
            : refundMatch;
        if (genericMatch === "none") {
          await db.transaction.update({ where: { id: t.id }, data: { isIncome: true } });
          continue;
        }
      }
      // falls through to merchant-memory/AI below, same as ordinary spend
    }

    // BNPL attribution (bnplKeyword / bnplBranchWouldFire, hoisted above so
    // the merchant-rule lookup can yield to this branch).
    //
    // Substring match (2026-08-16, was exact-match-only) — the original
    // reasoning was that "Klarna" alone is a generic installment-payment
    // line but "Nike - Klarna" is the purchase itself and must stay normal
    // spend (see debt-reassign.ts for the incident that taught that). But
    // once a plan is actually tracked as a Debt, its ongoing real charges
    // routinely keep carrying the retailer's name the whole way through —
    // confirmed against this household's own data (see the comment on
    // detectUnlinkedBnpl's own substring match, bnpl-detect.ts): neither of
    // their 2 real active plans ("Nike - Klarna," "GlassesUSA.com -
    // Klarna") ever posts as bare "Klarna," so the exact-match gate here
    // meant an already-tracked plan's real payments could never
    // auto-match at all (real report: a payment sitting unlinked for over
    // a week with the DebtPayment stuck reading "Overdue"). Safe to loosen
    // now that resolveBnplDebtId's own amount-tolerance + unique-candidate
    // check is the thing actually preventing a one-time unrelated purchase
    // from being misattributed — the merchant-text match was never doing
    // that job alone.
    if (bnplBranchWouldFire) {
      // This lender/plan (or, for two simultaneous same-price plans at the
      // same provider — real report, 2026-08-16 Afterpay — one of two) is
      // now a tracked debt. A checking-side "Affirm Payment" line is the
      // transaction that originally got it detected, so it adopts that
      // history instead of sitting there as unexplained spend, even when
      // resolveBnplDebtId can't tell exactly which of several equally-
      // qualifying plans it belongs to (debtId stays null then — the amount
      // still qualified against a real tracked plan, so this is a known
      // payment, just not attributable to one specific plan yet;
      // matchInstallmentPayments' own per-debt sweep, src/lib/debt-payments.ts,
      // fairly claims it from there).
      await db.transaction.update({
        where: { id: t.id },
        data: { isTransfer: true, debtId: resolveBnplDebtId(bnplKeyword!, t.amountCents, t.occurredOn) },
      });
      continue;
    }
    // already asked once, waiting on a human to confirm either axis
    if (t.aiSuggestedBucketId || t.aiSuggestedCategoryId) continue;
    // A still-pending transaction's merchant text is provisional (SimpleFIN
    // routinely sends a placeholder — "PENDING - 09/22 - VEHDTAPLN ..." —
    // that overwrites itself once the bank posts for real, see this
    // upsert's own comment above). Guessing a bucket off that text risks a
    // confident-looking but wrong "AI Guess" hint the household then acts
    // on — e.g. defaulting the "Needs a bucket" queue's Recurring tab
    // toward creating a brand-new bill for a charge that's actually an
    // *existing* tracked bill's payment, just not yet postable-matched
    // (household request, 2026-09-22: no suggestion at all while pending —
    // only matchBillPayments/matchRecurringPattern/MerchantRule above, which
    // commit to something *already set up* rather than proposing something
    // new, are fine to still apply). Left with no aiSuggestedBucketId, it
    // simply gets reconsidered here again on the next sync once it posts.
    if (t.pending) continue;
    // A non-budget-tracked account's spend was never meant to land in a
    // bucket automatically (see Account.budgetTracked) — leave it plain
    // uncategorized rather than spending an AI call guessing a bucket for
    // it, since even a confident guess could only ever land as a hint here.
    if (!budgetTracked) continue;
    // A P2P debit's merchant text ("Venmo", "Zelle") carries no per-merchant
    // signal to batch suggestBucketsForMerchants/suggestCategoriesForMerchants
    // on the way an ordinary merchant does — routed to its own
    // history-informed, always-suggest-only pass below instead (household
    // request, 2026-08-23: "confirm AI-suggested bucket and category,"
    // mirroring the existing P2P income-confirm flow) rather than being left
    // silently uncategorized the way it used to be.
    if (isP2PMerchant) {
      needsAiP2P.push({ id: t.id, merchant: t.merchant, party: t.resolvedMerchant ?? null, receiptNote: t.receiptNote ?? null, amountCents: t.amountCents, occurredOn: t.occurredOn, label: t.label, notes: t.notes });
      continue;
    }
    // effectiveMerchant, not t.merchant — so a receipt-resolved P2P charge
    // is batched and (on a confident result) gets its MerchantRule written
    // under the real party name, not "Venmo".
    needsAi.push({ id: t.id, merchant: effectiveMerchant, amountCents: t.amountCents });
  }

  if (needsAi.length > 0 && buckets.length > 0) {
    await runOrdinaryAiSuggestions(householdId, needsAi, buckets, categories, autoAssignableBucketIds, bnplKeywords);
  }
  if (needsAiP2P.length > 0 && (buckets.length > 0 || categories.length > 0)) {
    await runP2PAiSuggestions(householdId, needsAiP2P, buckets, categories);
  }

  // The only bucketId-committing branch above is the merchant-rule match
  // (bucketCommits) — querying final state here, rather than tracking it
  // inline through every branch/continue above, is what actually catches
  // every bucket a candidate landed in this run. checkAndSendBucketAlerts
  // was previously only ever called from manual bucket-assignment actions
  // (src/app/buckets/actions.ts) — a household relying on auto-sync alone
  // never got a WARNING/EXCEEDED/PACE push at all; this closes that gap for
  // every alert type, not just the new opt-in BUCKET_TRANSACTION one.
  const autoFiled = await db.transaction.findMany({
    where: { id: { in: candidates.map((c) => c.id) }, bucketId: { not: null } },
    select: { bucketId: true },
    distinct: ["bucketId"],
  });
  await checkAndSendBucketAlertsFor(autoFiled.flatMap((t) => (t.bucketId ? [t.bucketId] : [])));
}

// The ordinary-merchant AI-guess pass — batched per unique merchant, one
// suggestBucketsForMerchants + suggestCategoriesForMerchants call pair per
// batch, independent confidence gates (a merchant can have high bucket
// confidence and low/no category fit, or vice versa). Split out of
// categorizeUncategorizedTransactions above (2026-08-23) once it grew a
// second, differently-shaped AI pass (runP2PAiSuggestions below) sharing the
// same early-return structure.
async function runOrdinaryAiSuggestions(
  householdId: string,
  needsAi: { id: string; merchant: string; amountCents: number }[],
  buckets: { id: string; name: string; aiInstructions?: string | null }[],
  categories: { id: string; name: string; bucketId: string | null }[],
  autoAssignableBucketIds: Set<string>,
  bnplKeywords: string[],
): Promise<void> {
  // One representative amount per unique merchant — the largest, so a
  // merchant with mixed small/large charges (e.g. a card issuer used for
  // both an annual fee and a purchase) still reads as "can get big" rather
  // than looking like a small flat subscription fee.
  const amountByMerchant = new Map<string, number>();
  for (const t of needsAi) {
    amountByMerchant.set(t.merchant, Math.max(amountByMerchant.get(t.merchant) ?? 0, t.amountCents));
  }
  const uniqueNeedsAi = [...amountByMerchant.entries()].map(([merchant, amountCents]) => ({
    merchant,
    amountCents,
  }));

  // Phase 1: resolve bucket per merchant first — category choice depends on
  // which bucket a merchant lands in (categories are bucket-scoped, see the
  // schema comment on BillCategory.bucketId), so it has to be known before
  // category suggestion can even pick the right candidate list.
  const bucketSuggestions = new Map<string, { bucketName: string | null; confidence: number }>();
  for (let i = 0; i < uniqueNeedsAi.length; i += AI_BATCH_SIZE) {
    const batch = uniqueNeedsAi.slice(i, i + AI_BATCH_SIZE);
    const batchResult = await suggestBucketsForMerchants(householdId, batch, buckets);
    for (const [merchant, suggestion] of batchResult) bucketSuggestions.set(merchant, suggestion);
  }

  // Phase 2: group merchants by their resolved bucket, then run one
  // suggestCategoriesForMerchants batch per bucket, each scoped to only
  // that bucket's own categories — a merchant with no resolved bucket has
  // no valid category list to check against, so it's skipped for category
  // suggestion entirely (still gets a bucket hint/commit from phase 1).
  const categoriesByBucketId = new Map<string, { id: string; name: string }[]>();
  for (const c of categories) {
    if (!c.bucketId) continue;
    const arr = categoriesByBucketId.get(c.bucketId) ?? [];
    arr.push({ id: c.id, name: c.name });
    categoriesByBucketId.set(c.bucketId, arr);
  }
  const merchantsByBucketId = new Map<string, { merchant: string; amountCents: number }[]>();
  for (const m of uniqueNeedsAi) {
    const bucketName = bucketSuggestions.get(m.merchant)?.bucketName;
    const bucket = bucketName ? buckets.find((b) => b.name === bucketName) : undefined;
    if (!bucket || !categoriesByBucketId.has(bucket.id)) continue;
    const arr = merchantsByBucketId.get(bucket.id) ?? [];
    arr.push(m);
    merchantsByBucketId.set(bucket.id, arr);
  }
  const categorySuggestions = new Map<string, { categoryName: string | null; confidence: number }>();
  for (const [bucketId, merchants] of merchantsByBucketId) {
    const bucketCategories = categoriesByBucketId.get(bucketId)!;
    for (let i = 0; i < merchants.length; i += AI_BATCH_SIZE) {
      const batch = merchants.slice(i, i + AI_BATCH_SIZE);
      const batchResult = await suggestCategoriesForMerchants(householdId, batch, bucketCategories);
      for (const [merchant, suggestion] of batchResult) categorySuggestions.set(merchant, suggestion);
    }
  }

  for (const t of needsAi) {
    const bucketSuggestion = bucketSuggestions.get(t.merchant);
    const categorySuggestion = categorySuggestions.get(t.merchant);
    const bucket = bucketSuggestion?.bucketName ? buckets.find((b) => b.name === bucketSuggestion.bucketName) : undefined;
    // Only ever looked up from the bucket-scoped list above, so this can
    // never resolve to a category belonging to a different bucket.
    const category = categorySuggestion?.categoryName
      ? categoriesByBucketId.get(bucket?.id ?? "")?.find((c) => c.name === categorySuggestion.categoryName)
      : undefined;
    if (!bucket && !category) continue;

    // Cache every AI result, confident or not, so this merchant is never
    // sent to Gemini again — the confidence gates below only control
    // whether *this* transaction auto-files or waits for a human. A single
    // confidence covers both axes on the cached rule (MerchantRule has one
    // confidence/source pair, not one per field) — the min of whichever
    // sides actually matched, so a low-confidence category never rides in
    // on a high-confidence bucket's coattails on a later sync (or vice
    // versa).
    const confidences = [
      ...(bucket ? [bucketSuggestion!.confidence] : []),
      ...(category ? [categorySuggestion!.confidence] : []),
    ];
    // A bare BNPL provider name ("Affirm", "Klarna") is ambiguous across every
    // plan at that provider — don't bake a household-wide rule for it (see
    // dropAmbiguousBnplMerchantRules). This transaction still gets its
    // hint/commit below; it just won't leave behind a blanket rule that
    // shadows a tracked plan's installment attribution on a later sync.
    const isBareBnplMerchant = bnplKeywords.includes(t.merchant.trim().toLowerCase());
    if (!isBareBnplMerchant) {
      await upsertMerchantRule(
        householdId,
        t.merchant,
        { bucketId: bucket?.id ?? null, debtId: null, categoryId: category?.id ?? null, isTransfer: false, isIncome: false },
        { confidence: Math.min(...confidences), source: "AI" },
      );
    }

    // A RECURRING bucket never gets a silently committed bucketId — Gemini
    // still gets the full bucket list in its prompt (so it can recognize
    // "this looks like Subscriptions"), but that result can only ever land as
    // a hint here, regardless of confidence. MIXED buckets are auto-assignable
    // the same as SPEND — see the comment on autoAssignableBucketIds above.
    const bucketCommits =
      Boolean(bucket) && bucketSuggestion!.confidence >= 0.7 && autoAssignableBucketIds.has(bucket!.id);
    const bucketData = bucketCommits
      ? { bucketId: bucket!.id, aiSuggestedBucketId: null }
      : bucket
        ? { aiSuggestedBucketId: bucket.id }
        : {};
    // Category always travels with its bucket (2026-08-27 household rule — see
    // the merchant-rule branch above): `category` is already scoped to
    // `bucket`, so it commits only when the bucket does, and is hinted only
    // while the bucket is a hint.
    const categoryData =
      category && bucketCommits && categorySuggestion!.confidence >= 0.7
        ? { categoryId: category.id, aiSuggestedCategoryId: null }
        : category && bucket
          ? { aiSuggestedCategoryId: category.id }
          : {};
    const data = { ...bucketData, ...categoryData };
    if (Object.keys(data).length > 0) {
      await db.transaction.update({ where: { id: t.id }, data });
    }
  }
}

// The P2P AI-guess pass — one call per transaction batch (not per unique
// merchant, since every P2P transaction shares the same generic merchant
// text) via suggestP2PClassifications, always suggest-only regardless of
// confidence (see that function's own comment), no MerchantRule caching
// (a rule keyed on "venmo" would be meaningless across unrelated payments).
async function runP2PAiSuggestions(
  householdId: string,
  needsAiP2P: { id: string; merchant: string; party: string | null; receiptNote: string | null; amountCents: number; occurredOn: Date; label: string | null; notes: string | null }[],
  buckets: { id: string; name: string }[],
  categories: { id: string; name: string }[],
): Promise<void> {
  // The household's own recent CONFIRMED P2P classifications — real
  // precedent, not a guess (aiSuggested* excluded) — fed to the model as
  // few-shot examples so it can pattern-match a new payment against what
  // this household has actually called similar ones before, since the P2P
  // app's own merchant text carries no signal of its own. See the schema
  // comment on unlabeledP2PWhere (src/lib/p2p-transfers.ts) for the same
  // P2P-merchant OR-clause convention reused here.
  const p2pHistoryRows = await db.transaction.findMany({
    where: {
      householdId,
      AND: [
        { OR: P2P_DISCOVERY_KEYWORDS.map((k) => ({ merchant: { contains: k, mode: "insensitive" as const } })) },
        { OR: [{ bucketId: { not: null } }, { categoryId: { not: null } }] },
      ],
    },
    orderBy: { occurredOn: "desc" },
    take: 30,
    select: {
      amountCents: true,
      occurredOn: true,
      label: true,
      notes: true,
      receiptNote: true,
      bucket: { select: { name: true } },
      category: { select: { name: true } },
    },
  });
  const p2pHistory = p2pHistoryRows.map((h) => ({
    amountCents: h.amountCents,
    occurredOn: h.occurredOn,
    label: h.label,
    notes: h.notes,
    receiptNote: h.receiptNote,
    bucketName: h.bucket?.name ?? null,
    categoryName: h.category?.name ?? null,
  }));

  const P2P_AI_BATCH_SIZE = 20;
  const suggestions = new Map<string, { bucketName: string | null; categoryName: string | null; confidence: number }>();
  for (let i = 0; i < needsAiP2P.length; i += P2P_AI_BATCH_SIZE) {
    const batch = needsAiP2P.slice(i, i + P2P_AI_BATCH_SIZE);
    const batchResult = await suggestP2PClassifications(householdId, batch, buckets, categories, p2pHistory);
    for (const [id, suggestion] of batchResult) suggestions.set(id, suggestion);
  }

  for (const t of needsAiP2P) {
    const suggestion = suggestions.get(t.id);
    if (!suggestion) continue;
    const bucket = suggestion.bucketName ? buckets.find((b) => b.name === suggestion.bucketName) : undefined;
    const category = suggestion.categoryName ? categories.find((c) => c.name === suggestion.categoryName) : undefined;
    if (!bucket && !category) continue;

    // Never auto-commits bucketId/categoryId, regardless of confidence —
    // "it could be anything," per the household's own framing (2026-08-23).
    // Always a hint, always waiting on an explicit Confirm.
    const data = {
      ...(bucket ? { aiSuggestedBucketId: bucket.id } : {}),
      ...(category ? { aiSuggestedCategoryId: category.id } : {}),
    };
    if (Object.keys(data).length > 0) {
      await db.transaction.update({ where: { id: t.id }, data });
    }
  }
}

export type SyncResult = { accountsSynced: number; transactionsSynced: number };

export function syncHousehold(householdId: string): Promise<SyncResult> {
  // Tracked so the scheduled nudge checks wait for it, and single-flight per
  // household so overlapping triggers share one run (see sync-in-flight.ts).
  return singleFlight(householdId, () => trackSync(runHouseholdSync(householdId)));
}

async function runHouseholdSync(householdId: string): Promise<SyncResult> {
  // The demo household's SimpleFIN demo-server connection is frozen after the
  // one-time seed — never re-pull (would drift the curated example, and with
  // no AI key every new transaction piles up as "Needs a Bucket").
  if (await isDemoHousehold(householdId)) return { accountsSynced: 0, transactionsSynced: 0 };
  const connection = await db.bankConnection.findUnique({ where: { householdId } });
  if (!connection) throw new Error("No SimpleFIN connection for this household.");

  const accessUrl = decrypt(connection.accessUrlEncrypted);

  // Overlap on repeat syncs so a pending transaction that later posts (and
  // can change ID/amount) is never missed; 90 days back on first sync.
  // SimpleFIN's start-date filters on the *posted* date, and some issuers
  // add a transaction to the feed days after the date they post it under —
  // real report, 2026-10-08: Synchrony (Sam's Club Card) surfaced a 10/4
  // return and three September payments only after they'd aged out of the
  // old 3-day window, so they never imported while the balance (which
  // counted them) did. 14 days covers that lag; re-upserting rows already
  // on file is idempotent.
  const startDate = connection.lastSyncedAt
    ? new Date(connection.lastSyncedAt.getTime() - 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  let accountsSynced = 0;
  let transactionsSynced = 0;
  // Before any upsert — every row the feed returns gets updatedAt >= this,
  // which is how reconcileStalePendingRows tells "dropped by this sync."
  const syncStartedAt = new Date();

  try {
    const { accounts, errors } = await fetchSimpleFinData(accessUrl, {
      startDate,
      includePending: true,
    });

    // A brand-new account appearing under an already-syncing connection
    // (SimpleFIN re-issuing a fresh simpleFinAccountId for an existing real
    // card/bank — real report, 2026-09-14: Sam's Club Card switching to
    // route through Synchrony) would otherwise only ever get the same
    // narrow 14-day rolling window as every other account, silently missing
    // whatever posted between the reissue and this sync. Detected by
    // comparing against what's already on file, then backfilled with its
    // own 90-day fetch scoped to just those ids — transaction upserts are
    // keyed on simpleFinTransactionId, so the overlap with the main fetch
    // above is harmless.
    //
    // Also catches an account created by an *earlier* sync that ran before
    // this backfill existed (or one whose very first sync's 90-day fetch
    // otherwise came up empty) — the moment an account exists in the DB it
    // stops looking "new" to the check above on every later sync, so a
    // one-time gap like that would otherwise never self-heal. Narrowly
    // scoped to accounts created in roughly the last sync cycle with zero
    // Transaction rows on file, so it only ever fires for a genuinely-stuck
    // account, not one that's legitimately never had activity.
    if (connection.lastSyncedAt) {
      const knownAccounts = await db.account.findMany({
        where: { householdId },
        select: { id: true, simpleFinAccountId: true, createdAt: true },
      });
      const knownAccountIds = new Set(knownAccounts.map((a) => a.simpleFinAccountId));
      const newAccountIds = accounts.map((a) => a.id).filter((id) => !knownAccountIds.has(id));
      const recentlyCreated = knownAccounts.filter(
        (a) => a.createdAt.getTime() > Date.now() - 3 * 24 * 60 * 60 * 1000,
      );
      for (const acc of recentlyCreated) {
        if (newAccountIds.includes(acc.simpleFinAccountId)) continue;
        const txnCount = await db.transaction.count({ where: { accountId: acc.id } });
        if (txnCount === 0) newAccountIds.push(acc.simpleFinAccountId);
      }
      if (newAccountIds.length > 0) {
        const { accounts: backfilled } = await fetchSimpleFinData(accessUrl, {
          startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          includePending: true,
          accountIds: newAccountIds,
        });
        const backfilledById = new Map(backfilled.map((a) => [a.id, a]));
        for (const a of accounts) {
          const deeper = backfilledById.get(a.id);
          if (deeper) a.transactions = deeper.transactions;
        }
      }
    }

    for (const a of accounts) {
      const balanceCents = decimalStringToCents(a.balance);
      const accountType = guessAccountType(a);
      const syncMode = guessSyncMode(a, accountType);

      const account = await db.account.upsert({
        where: { simpleFinAccountId: a.id },
        create: {
          householdId,
          bankConnectionId: connection.id,
          simpleFinAccountId: a.id,
          name: a.name,
          orgName: a.org?.name,
          accountType,
          syncMode,
          balanceCents,
          lastSyncedAt: new Date(),
          // See the schema comment on Account.budgetTracked — set once at
          // creation only (not re-applied on update, same as
          // excludedFromNetWorth below it), so a household's manual toggle
          // in /settings/accounts always wins over this default afterward.
          budgetTracked: accountType === "CHECKING" || accountType === "SAVINGS",
        },
        update: {
          name: a.name,
          orgName: a.org?.name,
          balanceCents,
          lastSyncedAt: new Date(),
          // Re-applied every sync (not just at creation) so a classifier
          // improvement — like recognizing "Quicksilver"/"Venture" as cards —
          // self-heals existing accounts instead of needing a one-off fix.
          accountType,
          syncMode,
        },
      });
      accountsSynced++;

      // Keep any linked debt's balance current (credit cards/loans carry a
      // negative SimpleFIN balance for what's owed). Per-debt, not a bulk
      // updateMany, so paidOffDate can compare each debt's own old balance
      // against the new one (see nextPaidOffDate) — a plain updateMany has
      // no "old value" to compare against.
      const linkedDebts = await db.debt.findMany({
        where: { accountId: account.id },
        select: { id: true, balanceCents: true, paidOffDate: true, paidOffAmountCents: true },
      });
      // -balanceCents, not Math.abs(balanceCents) — SimpleFIN reports a
      // negative balance for what's owed (see the comment above), so a
      // *positive* balanceCents means the household is in credit (an
      // overpayment, or a refund posting after paying in full), not
      // negative debt. Math.abs() used to turn that credit into an equal
      // amount of phantom owed debt instead of the $0 it actually is
      // (2026-09-11 fix) — clamped to 0, never negative, same as every
      // other balanceCents write in this file.
      const newDebtBalanceCents = Math.max(0, -balanceCents);
      for (const linkedDebt of linkedDebts) {
        await db.debt.update({
          where: { id: linkedDebt.id },
          data: {
            balanceCents: newDebtBalanceCents,
            paidOffDate: nextPaidOffDate(linkedDebt.balanceCents, newDebtBalanceCents, linkedDebt.paidOffDate),
            paidOffAmountCents: nextPaidOffAmountCents(
              linkedDebt.balanceCents,
              newDebtBalanceCents,
              linkedDebt.paidOffAmountCents,
            ),
          },
        });
        await unhideDebtPaymentIfBalanceReturned(linkedDebt.id, linkedDebt.balanceCents, newDebtBalanceCents, linkedDebt.paidOffDate);
        await notifyIfDebtJustPaidOff(linkedDebt.id, linkedDebt.balanceCents, newDebtBalanceCents);
      }

      // Every synced CREDIT_CARD/LOAN account auto-becomes a tracked Debt
      // (2026-08-15 — was $0-balance-only: a placeholder aprBasisPoints:0/
      // minPaymentCents:0 is *accurate* at $0, since both are inert there
      // either way, but would be actively misleading for a real balance —
      // SimpleFIN's protocol has no interest-rate field at all, see
      // SimpleFinAccount in simplefin.ts, so a nonzero balance genuinely
      // needs a human to supply the real rate). Generalized so a household
      // never has to remember to manually "start tracking" a newly
      // connected card/loan — termsConfirmed:false for anything but $0
      // means it immediately shows up as "Needs setup" (see
      // hasDebtsNeedingAttention) with the real terms one tap away in
      // /settings/accounts, same as the BNPL quick-lender-create path's
      // placeholder convention. Re-checked every sync (not just at first
      // connect) so an account that reaches $0 later still picks this up,
      // same self-healing convention as everything else here.
      if ((accountType === "CREDIT_CARD" || accountType === "LOAN") && linkedDebts.length === 0) {
        const maxSort = await db.debt.aggregate({ where: { householdId }, _max: { sortOrder: true } });
        await db.debt.create({
          data: {
            householdId,
            name: account.name,
            debtType: "REVOLVING",
            // Pre-set from the account's own type rather than falling back to
            // DebtKind's CARD default — a tracked LOAN account otherwise never
            // reads as a loan anywhere that groups by kind (payoff planner's
            // composition chart, the "Manual Loan" group once detached), same
            // reasoning as the TrackAsDebtForm path in debts/actions.ts.
            kind: accountType === "LOAN" ? "LOAN" : "CARD",
            aprBasisPoints: 0,
            minPaymentCents: 0,
            balanceCents: newDebtBalanceCents,
            accountId: account.id,
            source: "SIMPLEFIN",
            termsConfirmed: newDebtBalanceCents === 0,
            sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          },
        });
      }

      const linkedGoals = await db.savingsGoal.findMany({ where: { accountId: account.id } });
      for (const goal of linkedGoals) {
        await db.savingsGoal.update({
          where: { id: goal.id },
          data: { currentAmountCents: Math.max(balanceCents, 0) },
        });
        await checkAndSendGoalAlerts(goal.id);
      }

      // Keep any linked net-worth asset (401k, brokerage, etc.) current too.
      await db.asset.updateMany({
        where: { accountId: account.id },
        data: { valueCents: Math.max(balanceCents, 0), asOfDate: todayAsUTCDate() }, // @db.Date — local calendar day
      });

      if (syncMode === "TRANSACTIONS") {
        // Each transaction's upsert is fully independent (keyed on its own
        // simpleFinTransactionId) — a bounded-concurrency map turns what used
        // to be one DB round trip per transaction, dead serial, into up to 8
        // in flight at once. A real sync can carry hundreds of transactions
        // across a household's accounts; this was measurably the slowest
        // part of a sync (see WORKING_ON.md).
        await mapConcurrent(a.transactions ?? [], 8, async (t) => {
          // SimpleFIN: negative = money out. Our convention: positive = spend.
          const amountCents = -decimalStringToCents(t.amount);
          const merchant = t.payee?.trim() || t.description?.trim() || "Unknown";
          // While still pending, SimpleFIN routinely sends `posted: 0` (no
          // real post date yet) and a placeholder merchant/description
          // ("Pending Lakeside Foods", "PENDING - 08/23 - ..."). The `update`
          // branch used to only ever refresh amountCents/pending, so a
          // transaction that started out pending kept its placeholder
          // merchant/rawDescription forever, even once it posted for real
          // with a proper description on a later sync — real report,
          // 2026-08-24: 130 of 1548 transactions (8.4%) stuck unresolved.
          // Now re-derives merchant/rawDescription from the current sync
          // payload on every upsert, same as create — cheap (just overwrites
          // with the same value once nothing's changed) and self-healing for
          // every already-broken row the next time its simpleFinTransactionId
          // happens to sync again.
          // `occurredOn` is `@db.Date` — a calendar day, no time. SimpleFIN
          // posts ~97% of transactions at noon UTC (safe: same day in every
          // timezone), but a few land in the 00:00–07:00 UTC window — evening
          // in America/Denver — and `new Date(posted*1000)` fed straight to
          // Prisma truncates in *UTC*, storing those a day ahead of the
          // household's own sense of the date (verified against the live
          // bridge 2026-08-31: 4 of 466 rows). Take the server-local (Denver)
          // calendar day instead, re-anchored to UTC midnight like every
          // other `@db.Date`. Self-heals on the next sync of each row once a
          // real posted date shows up (the upsert always rewrites occurredOn
          // once `t.posted` is truthy — see comment above).
          //
          // While still pending (`t.posted` falsy) there's no real date to
          // anchor to yet — used to hardcode the Unix epoch here, which
          // displayed as a bare "Jan 1" and read as a sync bug (real report,
          // 2026-09-09). Now: on first sight, use the day we're syncing on
          // (household-local "today" — the closest we have to when it
          // actually happened); on every later sync while it's still
          // pending, leave `occurredOn` alone rather than re-stamping it to
          // that day's "today" again, so the date doesn't keep drifting
          // forward for a charge that just sits pending a long time.
          const postedDate = t.posted ? new Date(t.posted * 1000) : null;
          const realOccurredOn = postedDate
            ? new Date(Date.UTC(postedDate.getFullYear(), postedDate.getMonth(), postedDate.getDate()))
            : null;
          const rawDescription = t.description?.trim() || null;
          await db.transaction.upsert({
            where: { simpleFinTransactionId: t.id },
            create: {
              householdId,
              accountId: account.id,
              simpleFinTransactionId: t.id,
              merchant,
              amountCents,
              occurredOn: realOccurredOn ?? todayAsUTCDate(),
              notes: t.memo || null,
              rawDescription,
              pending: Boolean(t.pending),
            },
            update: {
              merchant,
              amountCents,
              ...(realOccurredOn ? { occurredOn: realOccurredOn } : {}),
              rawDescription,
              pending: Boolean(t.pending),
            },
          });
          transactionsSynced++;
        });
      }
    }

    // An account deleted on SimpleFIN's side (e.g. "Disconnect" on one
    // institution from bridge.simplefin.org) just stops appearing in future
    // syncs' `accounts` list — SimpleFIN never tells us it's gone, so
    // without this it lingers in Flow forever (real report, 2026-08-20).
    // Hidden rather than hard-deleted (2026-08-21) so its transaction/debt/
    // asset history stays put — actually removed only via the household's
    // own deleteHiddenItem action (/settings/hidden), once hidden a year
    // (see Account.hiddenAt).
    // Guarded on accounts.length > 0: a transient upstream hiccup returning
    // an empty list must never read as "everything was deleted."
    if (accounts.length > 0) {
      const syncedIds = accounts.map((a) => a.id);
      const trackedAccounts = await db.account.findMany({
        where: { bankConnectionId: connection.id, hiddenAt: null },
        select: {
          id: true,
          simpleFinAccountId: true,
          accountType: true,
          missingFromFeedSince: true,
          debts: { select: { id: true, balanceCents: true } },
        },
      });
      const missingNow = trackedAccounts.filter((a) => !syncedIds.includes(a.simpleFinAccountId));
      const backNow = trackedAccounts.filter(
        (a) => syncedIds.includes(a.simpleFinAccountId) && a.missingFromFeedSince !== null,
      );

      if (backNow.length > 0) {
        await db.account.updateMany({
          where: { id: { in: backNow.map((a) => a.id) } },
          data: { missingFromFeedSince: null },
        });
      }

      // Debounced, not hidden the instant a single sync's response omits an
      // account — one still-connected account intermittently missing from an
      // otherwise-normal multi-account response reads identically to a real
      // disconnect if acted on immediately. Real incident, 2026-09-11: Sam's
      // Club (an already-known-flaky SimpleFIN connection) dropped out of
      // exactly one sync's response — every sibling account on the same
      // connection kept syncing fine before and after — and got silently
      // hidden along with its linked debt on the spot. Now the first miss
      // just starts the clock (missingFromFeedSince); only once an account
      // has stayed missing for a full GONE_FROM_FEED_GRACE_MS does it
      // actually get treated as gone.
      const now = new Date();
      const firstMiss = missingNow.filter((a) => a.missingFromFeedSince === null);
      if (firstMiss.length > 0) {
        await db.account.updateMany({
          where: { id: { in: firstMiss.map((a) => a.id) } },
          data: { missingFromFeedSince: now },
        });
      }
      const goneAccounts = missingNow.filter(
        (a) => a.missingFromFeedSince !== null && now.getTime() - a.missingFromFeedSince.getTime() >= GONE_FROM_FEED_GRACE_MS,
      );

      if (goneAccounts.length > 0) {
        // A paid-off loan whose servicer just stopped reporting the account
        // (common once the balance reaches $0) shouldn't be dragged into the
        // hidden bin along with it — the household still wants it on /debts as a
        // settled loan (its freed minimum keeps rolling into the payoff plan)
        // and in the "Manual Loan" group of Settings → Accounts, exactly where a
        // "move it from Connected to Manual" expectation points (real report,
        // 2026-09-01). Detach those to a plain manual $0 debt first; the account
        // still gets hidden below, its cascade just no longer finds a debt to
        // pull down (accountId is null now). Every other vanished account —
        // including a loan still carrying a balance — keeps the existing
        // hide-and-cascade behavior.
        const settledLoanDebtIds = goneAccounts
          .filter(
            (a) => a.accountType === "LOAN" && a.debts.length > 0 && a.debts.every((d) => d.balanceCents === 0),
          )
          .flatMap((a) => a.debts.map((d) => d.id));
        if (settledLoanDebtIds.length > 0) {
          await db.debt.updateMany({
            where: { id: { in: settledLoanDebtIds } },
            data: { accountId: null, source: "MANUAL", kind: "LOAN" },
          });
        }
        await hideAccountsWithLinkedDebts(goneAccounts.map((a) => a.id));
      }
    }

    // A HOME_EQUITY/VEHICLE_EQUITY asset pointed at the loan that secures it
    // (Asset.debtId, see linkAssetDebt) shows equity plus a blue "linked"
    // marker on /networth. Once that loan is settled — paid off ($0), or its
    // account vanished from the feed and the debt was hidden/detached above —
    // the equity breakdown is meaningless (equity == full value) and the
    // household expects the row to read "Paid Off (No Loan)" the way a
    // manually-cleared one does (real report, 2026-09-01: a paid-off truck
    // loan kept its blue "Linked to Ford F150 Loan" marker while the paid-off
    // vehicle beside it correctly showed the green check). Clear the link so
    // the row flips. Deliberately one-way — same convention as
    // Account.hiddenAt: if the balance ever climbs back (a correction, a HELOC
    // re-draw) the household re-links from the /networth debt picker rather
    // than it silently re-attaching.
    await detachSettledEquityDebtLinks(householdId);

    // Retire phantom "Jan 1" rows — a pending transaction the aggregator
    // stopped returning once it re-posted under a fresh id — before
    // categorization, so they never get an AI bucket guess spent on them or
    // nag in the uncategorized queue. See reconcileStalePendingRows.
    await reconcileStalePendingRows(householdId, syncStartedAt);

    // Email receipts before categorization: matchReceipts sets
    // Transaction.resolvedMerchant, which categorizeUncategorizedTransactions
    // then uses as the merchant key (turning an opaque "Venmo" charge into
    // an ordinary, learnable merchant). No EmailConnection for the household
    // -> all three return immediately. Never throws (a broken mailbox must
    // not abort the bank sync).
    // A few batches per sync (not a full drain) so a freshly-connected
    // mailbox with a 90-day backlog still catches up within a handful of
    // syncs even if the household never hits "Scan Now". Newest-first, so
    // recent receipts attach right away.
    await pollHouseholdEmails(householdId, { maxBatches: 3 });
    await matchReceipts(householdId);
    // Same poll pass as the receipts above — no second mailbox fetch.
    // Confirmation-gated (see BillAmountReview/DebtAmountReview source
    // EMAIL): never writes a bill/debt amount on its own.
    await matchBillNoticeAmounts(householdId);
    await purgeStaleReceipts(householdId);
    await purgeStaleBillNotices(householdId);
    await stampFreedMinimums(householdId);

    // Before every BNPL-identity-dependent pass below: locks in
    // Debt.bnplKeyword for any INSTALLMENT debt that doesn't have one yet,
    // so this same sync's own categorization/matching already reads through
    // the stable stored field rather than the live (renameable) debt name —
    // see that field's schema comment.
    await backfillBnplKeywords(householdId);

    // Before categorization: rescue any co-branded card payment a prior sync
    // filed as spending, now that its card-side leg has posted.
    await reconcileCategorizedCardPayments(householdId);
    await categorizeUncategorizedTransactions(householdId);
    // After categorization (a fresh charge has to be in *some* bucket first)
    // and after receipts matched above: move a charge whose matched receipt's
    // line items clearly belong in a different bucket than its merchant rule
    // chose — Sam's Club fuel out of Groceries (2026-09-21). Once per
    // transaction, never overrides a manual choice; see receipt-reclassify.ts.
    // A failure here must not abort the sync.
    try {
      await reclassifyFromReceipts(householdId);
    } catch (err) {
      console.error(`[receipt-reclassify] household ${householdId} failed:`, err);
    }
    // AI-batched, once-per-merchant-ever (see its own comment) — separate
    // from categorizeUncategorizedTransactions since it operates on
    // merchant recurrence across the whole 120-day window, not this sync's
    // freshly-seen transactions specifically.
    await checkForNewBnplLenders(householdId);
    await checkForNewSubscriptions(householdId);
    await matchBillPayments(householdId);
    // Own cycle-aware walk for every *scheduled* RecurringPattern (P2P
    // recurring with a real cadence/due date) — same "owns its own history"
    // relationship to the generic categorizer that matchBillPayments has to
    // RecurringBill (see that query's own comment in this file, and
    // pattern-payments.ts's doc comment).
    await matchPatternPayments(householdId);
    // After matchBillPayments, not before — needs this cycle's bill payment
    // (Transaction.billId) already set to have anything to link against.
    await matchReimbursements(householdId);
    await matchDebtPayments(householdId);
    await matchInstallmentPayments(householdId);
    await matchIncomePayments(householdId);
    // After matchIncomePayments — this month's ad hoc income pool
    // (getAdHocIncomeThisMonth) is only accurate once every real paycheck
    // this sync saw has already been linked to its own tracked Income
    // (incomeId set), so nothing gets double-counted as "ad hoc." No-ops
    // immediately unless the household has actually opted in (Household.
    // autoApplyAdHocIncomeToBuckets) — see bucket-ad-hoc-topup.ts.
    await autoApplyAdHocIncomeToBuckets(householdId);
    // After both debt-matching passes — captures the payoff plan's per-debt
    // extra allocation for *this* week now that this sync's payments have
    // actually been applied, so a later "Last Week's Bills"-style read has a
    // real historical record instead of asking the live plan (which only
    // ever knows today's current state — see snapshotPlannedExtraForCurrentWeek's
    // own comment, debt-payments.ts).
    await snapshotPlannedExtraForCurrentWeek(householdId);

    // Newline-joined since lastError is a single field but SimpleFIN can
    // report one error per linked institution (e.g. one bank needs
    // re-auth while the rest sync fine) — storing only errors[0] used to
    // silently drop every error but the first. Settings/simplefin splits
    // this back into one entry per line.
    const newLastError = errors.length > 0 ? errors.join("\n") : null;
    await db.bankConnection.update({
      where: { id: connection.id },
      data: {
        status: "ACTIVE",
        lastSyncedAt: new Date(),
        lastError: newLastError,
      },
    });
    // A per-institution auth problem (one bank needs re-auth) doesn't fail
    // the sync overall, so it never reaches the catch block below — this is
    // the only place that case is ever surfaced. Fires only when the error
    // text is new or changed, never for an already-known, still-unfixed
    // institution — syncAllHouseholds runs this on a timer, and re-notifying
    // every single run while the household just hasn't gotten to it yet
    // would be pure noise. Owner-only (ACCOUNT_SYNC_ISSUE,
    // notification-preferences.ts) — fixing this is a requireOwner()-gated
    // action on /settings/accounts. Household request, 2026-09-27.
    if (newLastError && newLastError !== connection.lastError) {
      try {
        await sendPushToHouseholdForType(householdId, "ACCOUNT_SYNC_ISSUE", {
          title: "An Account Needs Attention",
          body: "A connected bank needs to be reconnected — check Settings > Accounts.",
          url: "/settings/accounts",
        });
      } catch (err) {
        console.error(`[account-sync-issue] household ${householdId} push failed:`, err);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.bankConnection.update({
      where: { id: connection.id },
      data: { status: "ERROR", lastError: message },
    });
    // Only the ACTIVE -> ERROR transition notifies — an already-failing
    // connection doesn't re-fire on every subsequent scheduled attempt while
    // it stays broken, same reasoning as the per-institution case above.
    if (connection.status !== "ERROR") {
      try {
        await sendPushToHouseholdForType(householdId, "ACCOUNT_SYNC_ISSUE", {
          title: "Account Sync Failed",
          body: `The last sync couldn't complete: ${message}`,
          url: "/settings/accounts",
        });
      } catch (pushErr) {
        console.error(`[account-sync-issue] household ${householdId} push failed:`, pushErr);
      }
    }
    throw err;
  }

  return { accountsSynced, transactionsSynced };
}

export async function syncAllHouseholds(): Promise<void> {
  const connections = await db.bankConnection.findMany({
    where: { household: { isDemo: false } },
    select: { householdId: true },
  });
  for (const c of connections) {
    try {
      await syncHousehold(c.householdId);
    } catch (err) {
      console.error(`[simplefin-sync] household ${c.householdId} failed:`, err);
    }
  }
}

// Debt.freedMinimumCents bookkeeping (see its schema comment): remember a
// paid-off debt's last real minimum while it still shows one, so the payoff
// plan keeps rolling it after the card's own minimum later reads $0; forget it
// once the debt carries a balance again (it owes its own minimum then).
async function stampFreedMinimums(householdId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "Debt" SET "freedMinimumCents" = "minPaymentCents"
    WHERE "householdId" = ${householdId} AND "balanceCents" <= 0 AND "minPaymentCents" > 0
      AND "freedMinimumCents" IS DISTINCT FROM "minPaymentCents"`;
  await db.debt.updateMany({
    where: { householdId, balanceCents: { gt: 0 }, freedMinimumCents: { not: null } },
    data: { freedMinimumCents: null },
  });
}
