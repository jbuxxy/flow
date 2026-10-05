"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { AlertTriangle, CalendarClock, Check, Clock, CreditCard, DollarSign, Link2, LogOut, Receipt, Repeat, Scissors, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { reassignTransaction, setAmountRoutingRule } from "@/app/buckets/actions";
import { preservingScroll } from "@/lib/preserve-scroll";
import { TrackAsBillForm } from "@/app/buckets/[id]/track-as-bill-form";
import { PatternPanel } from "@/components/pattern-panel";
import { PatternFields } from "@/components/pattern-fields";
import { updatePattern, deletePattern, linkReceiptToTransaction, dismissReceipt, type PatternFormState } from "./actions";
import type { PatternData } from "@/components/pattern-row";
import { useTransactionLabelEditor } from "@/components/transaction-label-editor";
import { MerchantLogo } from "@/components/merchant-logo";
import { ReceiptDetailBlock } from "@/components/receipt-detail-block";
import { deriveP2PDisplay, bankDescriptionFor } from "@/lib/transaction-display";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";
import { updateIncome, type IncomeFormState } from "@/app/income/actions";
import { ReimbursementLinker, type ReimbursementCandidate } from "@/components/reimbursement-linker";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import { CARD_PAYMENT_MERCHANT_PATTERN, debtNameMatchesMerchant } from "@/lib/debt-payment-pattern";
import { looksLikeBnplMerchant } from "@/lib/bnpl-keywords";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";
import { AmountRoutingToggle, MakeRuleToggle, suggestRoutingMax, type RoutingDirection } from "@/components/amount-routing-toggle";
import { RowActions, type RowAction } from "@/components/row-actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";

type BucketOption = { id: string; name: string; trackingMode: "SPEND" | "RECURRING" | "MIXED" };
// BNPL is filtered out upstream (src/app/transactions/page.tsx's
// debtOptions) — every BNPL debt already has its DebtPayment created
// atomically at creation time, so an existing one is never a valid pick
// from either TrackAsBillForm or PatternPanel's debt pickers.
type DebtOption = { id: string; name: string; kind: "CARD" | "LOAN" };
type BillOption = { id: string; name: string };

type TransactionData = {
  id: string;
  merchant: string;
  amountCents: number;
  occurredOn: Date;
  notes: string | null;
  label: string | null;
  bucketId: string | null;
  bucketName: string | null;
  debtName: string | null;
  // Pre-derived "<plan name>" title for a BNPL installment charge linked to a
  // plan (installmentDisplayTitle, src/lib/transaction-display.ts) —
  // replaces the opaque per-charge bank descriptor as the row title. Null for
  // everything else.
  installmentTitle: string | null;
  // "3/6" schedule position for that same installment charge
  // (installmentDisplaySuffix) — shown at the very end of the subline in the
  // subline's own plain gray, not folded into the title above and not
  // colored like the classification text before it (green/amber is reserved
  // for the account/bucket/category classification — 2026-09-14 correction).
  // Null whenever installmentTitle is.
  installmentSuffix: string | null;
  billName: string | null;
  // The RecurringBill's own BillCategory, when this transaction fulfilled
  // one (billName set) and that bill has a category picked — additive to
  // bucketName, not a replacement for it (see the billId schema comment: a
  // bill purchase still carries its usual bucketId).
  billCategoryName: string | null;
  // This transaction's own subcategory (not a bill's — see billCategoryName
  // above, which stays additive/separate) — set manually via Reclassify, or
  // learned/auto-applied the same way bucketId is (see
  // MerchantRule.categoryId, categorizeUncategorizedTransactions).
  categoryId: string | null;
  categoryName: string | null;
  // AI's best-guess bucket/category, never auto-applied by their mere
  // presence — surfaced as a pre-fill (Reclassify) or, for a P2P debit, a
  // one-click Confirm (see needsP2PDebitConfirm below).
  aiSuggestedBucketId: string | null;
  aiSuggestedCategoryId: string | null;
  // Full editable Income data, not just its name — lets the Repeat badge
  // below open an inline edit panel for the Income this transaction matched
  // (matchIncomePayments), reusing the same updateIncome action IncomeRow's
  // own edit form uses (src/app/income/income-row.tsx).
  income: {
    id: string;
    name: string;
    amountCents: number;
    cadence: "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY";
    nextPayDate: Date | null;
  } | null;
  // Full editable pattern data, not just its label — lets the Repeat badge
  // below open an inline edit/delete panel for the pattern that claimed
  // this transaction, reusing the same PatternFields form as PatternRow
  // (src/components/pattern-row.tsx).
  pattern: PatternData | null;
  isIncome: boolean;
  isTransfer: boolean;
  // A P2P credit auto-defaults to isIncome:true unconfirmed (see
  // simplefin-sync.ts) — oneOff:true is what distinguishes "the household
  // actually confirmed this" from just the sync-time default. See
  // needsP2PIncomeConfirm/isConfirmedPlainIncome below.
  oneOff: boolean;
  accountLabel: string | null;
  // Account.budgetTracked (true for manual entries — see budgetTrackedWhere
  // in src/lib/buckets.ts). An unclassified transaction here means two very
  // different things depending on this: a real "needs a bucket" gap, or a
  // non-budget-tracked card/loan whose spend was never meant to land in a
  // bucket at all.
  accountBudgetTracked: boolean;
  billId: string | null;
  debtPaymentId: string | null;
  reimbursesTransaction: { id: string; merchant: string; amountCents: number; occurredOn: Date } | null;
  reimbursesMerchant: string | null;
  // The reverse side of reimbursesTransaction — every credit that pays *this*
  // charge back (a person Venmo-ing back their share of a bill, say). Shown
  // as its own "Reimbursed by X" line/badge, distinct from isReimbursed
  // above (which is this transaction itself being a credit that reimburses
  // something else) — a charge can be on the receiving end of this without
  // ever being a credit itself.
  reimbursedBy: { id: string; merchant: string; amountCents: number; occurredOn: Date }[];
  // The household already reviewed this unlinked credit's refund candidates
  // and said none apply — see dismissRefundReview, ReimbursementLinker.
  refundReviewDismissed: boolean;
  // Split-credit offsets (see TransactionOffset) — slices of this credit
  // earmarked against specific payments (a loan payoff), with the remainder
  // still counting as income. Mutually exclusive with reimburses* above.
  offsets: { id: string; amountCents: number; debitMerchant: string; debitDebtName: string | null }[];
  // SimpleFIN's own "not settled yet" flag — bank-returned, shown only in
  // the expanded detail view alongside `notes` (see the collapsed/expanded
  // split below).
  pending: boolean;
  // SimpleFIN's raw `description` field — separate from `merchant` (which
  // prefers `payee`). null for any transaction synced before this field
  // existed. Shown in the expanded view only when it adds something
  // `merchant` doesn't already say.
  rawDescription: string | null;
  // --- Email-receipt enrichment (see src/lib/receipt-sync.ts) ---
  // The real party from a matched receipt ("Jane's Dog Walking" behind a
  // bare "Venmo"). Shown instead of `merchant` in the row title when set;
  // `merchant` still drives P2P/BNPL/debt detection below.
  resolvedMerchant: string | null;
  // True when resolvedMerchant is an individual (a friend/family P2P payee).
  // The row then shows "Venmo · Ryan Carter" with the app's logo rather
  // than the bare name (which would draw a wrong company's guessed logo).
  resolvedMerchantIsPerson: boolean;
  // True when a receipt is actually linked to this transaction (Receipt row
  // exists) — drives the small receipt glyph in the row title. Distinct from
  // receiptSuggestion below, which is an *un*linked candidate.
  hasReceipt: boolean;
  // The linked receipt's own date (purchase date, else email received date),
  // "YYYY-MM-DD" — shown in the expanded "From Receipt" block's fallback line
  // when the receipt carries no items/note of its own.
  receiptDate: string | null;
  receiptItems: ReceiptLineItem[] | null;
  receiptTotalCents: number | null;
  // The payment memo / stated purpose off the matched receipt email.
  receiptNote: string | null;
  // The P2P app a matched receipt was paid through, when the bank descriptor
  // itself is opaque ("Transfer to Venmo"): "Venmo" / "PayPal" / …. Used for
  // the "Venmo · Name" title (person payee) and the "Paid with Venmo" line
  // in the expanded receipt block (merchant payee).
  receiptPaidWith: string | null;
  // The single best unmatched receipt that could belong to this transaction
  // (amount + date), offered as an inline "attach" prompt when the
  // transaction has no receipt yet. See matchReceipts / the /settings/email
  // queue for the automatic + full-picker paths.
  receiptSuggestion: {
    id: string;
    party: string | null;
    p2pApp: string | null;
    totalCents: number | null;
    itemSummary: string | null;
    noteText: string | null;
  } | null;
};

export type ReceiptLineItem = {
  description: string;
  qty: number | null;
  unitPriceCents: number | null;
  totalCents: number | null;
};

const initialPatternState: PatternFormState = {};
const initialIncomeState: IncomeFormState = {};
const INCOME_CADENCE_LABEL: Record<"BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY", string> = {
  BIWEEKLY: "Biweekly",
  SEMI_MONTHLY: "Semi-Monthly",
  MONTHLY: "Monthly",
};

// Computed from the same mutually-exclusive fields documented in
// WORKING_ON.md (bucketId / debtId+isTransfer / isIncome / isTransfer alone
// / patternId) plus the additive billId/incomeId/patternId annotations —
// this is the one place in the app that shows a transaction's full
// classification state regardless of which page it would otherwise be
// buried on. Reimbursed/refunded credits are the one exception: that story
// (who it pays back, the amount/date, the bucket it nets against) is told
// entirely by ReimbursementLinker's own linked-state row below instead —
// this function is never even called for those (see `isReimbursed` in
// TransactionRow) so its bucket/income/transfer branches below can't
// double up with it.
// `icon` replaces a descriptive prefix word ("Debt payment: ", "Income · ",
// "Transfer · ") with a small glyph instead, for anything tied to a
// recurring definition — a debt payment gets the same `CreditCard` glyph
// bottom-nav already uses for the Debts tab, everything else recurring
// (a matched bill/subscription, pattern, or tracked income) gets `Repeat`,
// the same glyph this row's own expanded panel already uses for "recurring"
// (2026-08-25 request: read the specific name at a glance, not a repeated
// category word). `null` means plain text, no icon — a one-off/unmatched
// case has no recurring definition to point at.
function classificationLabel(
  t: TransactionData,
  bnplKeywords: string[],
  debts: DebtOption[],
): { text: string; amber: boolean; icon: "debt" | "recurring" | null } {
  if (t.bucketName) {
    const category = t.billCategoryName ?? t.categoryName;
    // billName (RecurringBill) is the common case, but a bucket-targeted
    // P2P RecurringPattern match (patternMatchData sets isTransfer:false
    // whenever pattern.bucketId is set, so it lands in this branch too, not
    // the isTransfer branch below) is just as "recurring" and was missing
    // its Repeat icon entirely until this fix — real report, 2026-09-11
    // (a Venmo payee / a preschool payment, bucketId: Kids' Activities).
    return {
      text: category ? `${t.bucketName} · ${category}` : t.bucketName,
      amber: false,
      icon: t.billName || t.pattern ? "recurring" : null,
    };
  }
  if (t.debtName) {
    return { text: t.debtName, amber: false, icon: "debt" };
  }
  if (t.isIncome) {
    // t.income (a tracked Income record) is the common case, but a
    // countsAsIncome:true CREDIT RecurringPattern match sets isIncome:true
    // the same way (patternMatchData) with no Income record behind it —
    // same gap as the bucket branch above, same fix.
    if (t.income) return { text: t.income.name, amber: false, icon: "recurring" };
    if (t.pattern) return { text: t.pattern.label, amber: false, icon: "recurring" };
    return { text: "Income", amber: false, icon: null };
  }
  if (t.isTransfer) {
    // isTransfer:true/debtId:null actually covers THREE different things
    // the stored fields alone can't tell apart — categorizeUncategorizedTransactions
    // (simplefin-sync.ts) sets this exact state for a real internal transfer
    // (matchInternalTransfers, checking<->savings), for a charge that only
    // *looks* BNPL-related by merchant text but hasn't been attributed to a
    // specific tracked plan yet (see looksLikeBnplMerchant's own comment,
    // src/lib/bnpl-keywords.ts), AND for a checking-side "Transfer to Loan"/
    // "Capital One Credit Card Payment" line that looks like a debt/card
    // payment (CARD_PAYMENT_MERCHANT_PATTERN/debtNameMatchesMerchant,
    // src/lib/debt-payment-pattern.ts — the same heuristic offering "Debt
    // payment" in the Reclassify dropdown below) but couldn't be pinned to
    // one specific tracked Debt (ambiguous, or not tracked yet). Calling
    // either of the latter two a bare "Transfer" is actively misleading —
    // real report, 2026-08-24 for the BNPL case, 2026-08-25 for this one
    // ("transfer" must mean only money moving between the household's own
    // accounts, never a debt/P2P/BNPL payment) — neither is a settled
    // internal move.
    if (looksLikeBnplMerchant(t.merchant, bnplKeywords)) {
      return { text: "Possible BNPL Payment", amber: true, icon: null };
    }
    // Excludes true P2P merchant text the same way the server-side
    // "unresolvedDebt" filter (transactions/page.tsx) does — a Venmo/Zelle/
    // Cash App/Apple Cash debit is never actually a card/loan payment, even
    // when its text contains "payment". "paypal" stays eligible since it can
    // genuinely be a PayPal Credit debt payment (p2p-keywords.ts).
    const isP2PMerchantText = P2P_DISCOVERY_KEYWORDS.filter((k) => k !== "paypal").some((k) =>
      t.merchant.toLowerCase().includes(k),
    );
    if (
      !isP2PMerchantText &&
      (CARD_PAYMENT_MERCHANT_PATTERN.test(t.merchant) || debts.some((d) => debtNameMatchesMerchant(t.merchant, d.name)))
    ) {
      return { text: "Possible Debt Payment", amber: true, icon: "debt" };
    }
    return { text: t.pattern ? t.pattern.label : "Transfer", amber: false, icon: t.pattern ? "recurring" : null };
  }
  if (!t.accountBudgetTracked) {
    return { text: "Not Used for Budgeting", amber: false, icon: null };
  }
  return { text: "Uncategorized", amber: true, icon: null };
}

export function TransactionRow({
  transaction,
  buckets,
  debts,
  trackedDebts = [],
  bills = [],
  categories,
  labelSuggestions = [],
  reimbursementSuggestions = [],
  bnplKeywords = [],
}: {
  transaction: TransactionData;
  buckets: BucketOption[];
  debts: DebtOption[];
  // Debts a real payment can be manually attached to (already have a
  // DebtPayment tracker) — the opposite set from `debts` above, which is
  // scoped to untracked debts for TrackAsBillForm/PatternPanel's "start
  // tracking this one" flow. See the comment on attachableDebtOptions,
  // src/app/transactions/page.tsx.
  trackedDebts?: { id: string; name: string }[];
  bills?: BillOption[];
  categories: CategoryOption[];
  labelSuggestions?: string[];
  reimbursementSuggestions?: ReimbursementCandidate[];
  // The household's static + AI-learned BNPL keywords (allBnplKeywords,
  // src/lib/bnpl-detect.ts) — fetched once by the page (server-only, so
  // can't be looked up from this client component) and passed down for
  // classificationLabel's own use.
  bnplKeywords?: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [linkingOpen, setLinkingOpen] = useState(false);
  // Controls RowActions' own drawer from out here — needed so the X can
  // close the Move/Track panel along with the drawer (not just the drawer),
  // and so those panels' own successful submit can close the drawer right
  // back (nothing else can reach into RowActions' internal state).
  const [actionsOpen, setActionsOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const [editingPattern, setEditingPattern] = useState(false);
  const [editingIncome, setEditingIncome] = useState(false);
  const [incomeCadence, setIncomeCadence] = useState(transaction.income?.cadence ?? "BIWEEKLY");
  // Pre-fills with the transaction's *current* bucket first, not just an
  // unconfirmed AI hint — otherwise reclassifying an already-bucketed
  // transaction just to change its category opened on a blank "Select…"
  // (real report, 2026-08-23: Domino's already sat in Dining, but the
  // category picker below never appeared since it only shows once
  // `selection` actually names a bucket, and nothing pre-selected the one
  // it already had).
  const [selection, setSelection] = useState(
    transaction.bucketId
      ? `bucket:${transaction.bucketId}`
      : transaction.aiSuggestedBucketId
        ? `bucket:${transaction.aiSuggestedBucketId}`
        : "",
  );
  const [categoryId, setCategoryId] = useState<string | null>(transaction.categoryId ?? transaction.aiSuggestedCategoryId);
  // "Only route this merchant here under $X" — writes an amount-bounded
  // merchant rule rather than overwriting the merchant's base rule the way a
  // plain Move does (setAmountRoutingRule, src/app/buckets/actions.ts).
  const [routeBounded, setRouteBounded] = useState(false);
  const [routeDirection, setRouteDirection] = useState<RoutingDirection>("under");
  const [boundedMax, setBoundedMax] = useState(() => suggestRoutingMax(transaction.amountCents));
  const [routeError, setRouteError] = useState<string | null>(null);
  // "…and make this the rule for every charge from this merchant" — opt-in,
  // off by default: a plain Move corrects this one transaction and leaves the
  // household's merchant rule alone (Amazon, Walmart etc. legitimately land in
  // many buckets).
  const [makeRule, setMakeRule] = useState(false);
  const [pending, startTransition] = useTransition();
  const [markIncomePending, startMarkIncome] = useTransition();
  const [patternState, patternFormAction, patternPending] = useActionState(
    updatePattern.bind(null, transaction.pattern?.id ?? ""),
    initialPatternState,
  );
  const [deletePatternPending, startDeletePattern] = useTransition();
  const [incomeState, incomeFormAction, incomePending] = useActionState(
    updateIncome.bind(null, transaction.income?.id ?? ""),
    initialIncomeState,
  );
  const { justSaved: incomeJustSaved } = useActionToast(incomePending, incomeState, { success: "Income Saved" });
  useActionToast(patternPending, patternState, { success: "Pattern Saved" });
  // Specifically a card/loan statement payment (auto-detected via
  // CARD_PAYMENT_MERCHANT_PATTERN, simplefin-sync.ts) — isTransfer is also
  // true for a plain P2P transfer that matched a "tag only, don't count as
  // spending" pattern (the blank-target option in PatternFields' target
  // dropdown) with no debt behind it at all, which is NOT the same thing:
  // unlike a card payment, that one was never confirmed as fully resolved
  // forever, so it still needs a way to become a recurring pattern or get
  // reclassified as income later (real report, 2026-08-18: gating all of
  // this on bare isTransfer made every "tag only" Venmo transfer
  // permanently lose its track/mark-as-income buttons too, not just
  // genuine card payments).
  const isDebtTransfer = transaction.isTransfer && Boolean(transaction.debtName);
  // A P2P transaction is "already tracked" once a RecurringPattern has
  // claimed it (transaction.pattern set) — billId/debtPaymentId never apply
  // to it, since PatternPanel below (not TrackAsBillForm) is what tracks
  // it. isDebtTransfer folded in too: a card/loan statement payment is
  // already fully explained by its own classification line — nothing left
  // to "track." transaction.income folded in 2026-08-20: a paycheck matched
  // to a tracked Income (matchIncomePayments) is just as "already tracked"
  // as a pattern/bill/debt-payment match — omitting it made the "track as
  // recurring" CalendarClock button show up right next to the Repeat badge
  // on an already-tracked income transaction (real report: a paycheck's
  // employer name showed both icons at once).
  const [tracked, setTracked] = useState(
    Boolean(transaction.billId || transaction.debtPaymentId || transaction.pattern || isDebtTransfer || transaction.income),
  );
  // Linked to a specific purchase (a return) or a bare merchant (a refund
  // whose original purchase wasn't pinned down) — ReimbursementLinker's own
  // linked-state row is the one place this story gets told (see
  // classificationLabel above), and "already explained as a refund" is also
  // why the recurring-pattern and mark-as-income icons below stay hidden for
  // it: nothing left to reclassify. Reactive to unlinking (the "X" on that
  // row) via revalidatePath — see linkReimbursement/unlinkReimbursement,
  // src/app/transactions/actions.ts — which refreshes these props straight
  // from the server, no local state of its own needed here.
  const isReimbursed = Boolean(transaction.reimbursesTransaction || transaction.reimbursesMerchant);
  // This charge's own side of the story — someone paid it back. Independent
  // of isReimbursed (that's for the credit doing the paying-back).
  const wasReimbursed = transaction.reimbursedBy.length > 0;
  // Split across debt-payment offsets (see TransactionOffset) — still income
  // for the remainder, so not "reimbursed," but the linker stays open for
  // editing and isConfirmedPlainIncome must not lock it.
  const hasOffsets = transaction.offsets.length > 0;
  // Collapsed-row scissors indicator + its tooltip — a split credit's
  // header amount is the gross deposit, but part of it is already carved
  // off against debt payments (see the ReimbursementLinker split panel the
  // expanded row shows). Without this, the row reads as pure income.
  const offsetTotalCents = transaction.offsets.reduce((sum, o) => sum + Math.abs(o.amountCents), 0);
  const offsetRemainderCents = Math.abs(transaction.amountCents) - offsetTotalCents;
  const offsetSummary = hasOffsets
    ? `${formatCents(offsetTotalCents)} Split To ${transaction.offsets
        .map((o) => o.debitDebtName ?? o.debitMerchant)
        .join(", ")} · ${formatCents(offsetRemainderCents)} Still Counts As Income`
    : "";
  // amountCents > 0 is money out (debit), < 0 is money in (credit) — same
  // convention as everywhere else. A debit can only ever go to a Bucket or
  // an already-tracked Debt payment (trackedDebts — see the comment on
  // attachableDebtOptions, src/app/transactions/page.tsx) — never Income,
  // and no manual "Transfer" option: an ordinary purchase (Wingstop, gas)
  // just never has a debt to pick, so the group renders empty and adds no
  // clutter. P2P (Venmo/Zelle/etc.) gets the Debt payment option too now
  // (2026-08-26: a genuinely P2P-branded "PayPal" merchant is exactly how a
  // manual/unlinked debt's real payment shows up, with no other way to
  // attach it) — a *recurring* one is still better set up as a
  // RecurringPattern instead (the CalendarClock icon below), this is just
  // the one-off catch-up path. A non-transfer credit can only
  // ever be Income (confirmed plain one-time, or matched to a tracked
  // recurring Income) or linked as a reimbursement (see ReimbursementLinker
  // below), never both at once — isConfirmedPlainIncome/tracked hide
  // Link once one is picked, and isReimbursed above hides "mark/confirm as
  // income" — and never a manually-picked Bucket/Debt payment. A P2P
  // credit specifically starts life already isIncome:true (see
  // simplefin-sync.ts) but unconfirmed, so both affordances stay visible
  // together until the household picks one (needsP2PIncomeConfirm below).
  // An isDebtTransfer credit (a card/loan payment) skips both: it's
  // already fully explained by its classification line, so neither
  // "confirm as income" nor Link (which only ever means "got money back
  // for a specific purchase," never "this statement payment") makes sense
  // for it.
  const isDebit = transaction.amountCents > 0;
  const bankDescription = bankDescriptionFor(transaction);
  const isP2P = P2P_DISCOVERY_KEYWORDS.some((k) => transaction.merchant.toLowerCase().includes(k));
  // A credit sync already recognized as refund-shaped (real spend history at
  // this exact merchant — see tryAutoLinkRefund/hasSpendHistory,
  // simplefin-sync.ts) and left isIncome:false specifically so it lands
  // here instead of defaulting to income. Excludes P2P: those stay
  // isIncome:true-but-unconfirmed by design (needsP2PIncomeConfirm below)
  // since a Venmo/Zelle credit could still genuinely be recurring income,
  // not just a refund — "Track As Recurring"/"Mark As Income" still make
  // sense for that one. A plain merchant refund, though, is never going to
  // be recurring income; only Link (or dismissing it) applies (real
  // household report, 2026-09-05: those two actions "don't make sense for
  // refunds" — this is a new type of transaction, not a plain unclassified
  // credit).
  const isRefundCandidate =
    !isDebit && !isDebtTransfer && !tracked && !isReimbursed && !hasOffsets && !isP2P && !transaction.isIncome;
  const classification = isReimbursed
    ? null
    : isRefundCandidate
      ? transaction.refundReviewDismissed
        ? // Dismissed stays visible in the collapsed subline too, not just
          // inside the (tap-to-expand) panel — otherwise a dismissed credit
          // still reads as amber "needs attention" forever, indistinguishable
          // from one nobody's looked at yet.
          { text: "Not A Refund", amber: false, icon: null as "debt" | "recurring" | null }
        : { text: "Possible Refund", amber: true, icon: null as "debt" | "recurring" | null }
      : classificationLabel(transaction, bnplKeywords, debts);
  // A matched receipt whose total doesn't line up with what actually posted
  // — a tip added after the fact, a partial capture, a possible duplicate.
  const receiptMismatch =
    transaction.receiptTotalCents != null &&
    transaction.receiptTotalCents !== Math.abs(transaction.amountCents);
  const [selKind, selId] = selection.split(":");
  // The Move is genuinely changing buckets (not just a category tweak on the
  // one it's already in) and the merchant is a real, ruleable one — the
  // conditions for offering "only route <merchant> here under $X".
  const showRouting =
    selKind === "bucket" && selId !== transaction.bucketId && !isP2P && transaction.accountBudgetTracked;
  // Moving a transaction that was already committed to a different bucket —
  // the case where "…make this the rule too" is worth offering (a first-time
  // assignment already teaches the rule by default, server-side).
  const isRebucketing =
    selKind === "bucket" &&
    Boolean(transaction.bucketId) &&
    selId !== transaction.bucketId &&
    !isP2P &&
    transaction.accountBudgetTracked;
  // A P2P credit defaults to isIncome:true the moment it syncs (see
  // simplefin-sync.ts) — oneOff:false is the only thing distinguishing
  // "still needs a household decision" from "confirmed" for one, since
  // that's what actually drops it out of getUnlabeledP2PTransfers
  // (src/lib/p2p-transfers.ts). The three things a household can decide it
  // actually is: plain one-time income (Confirm, below — by far the most
  // common), a reimbursement (one-off or recurring, via
  // ReimbursementLinker/PatternPanel), or genuine recurring income
  // (PatternPanel's countsAsIncome, via the CalendarClock button). Folds in
  // tracked/isReimbursed the same way the rest of this component does:
  // once any of those three has actually happened, nothing left to decide.
  const needsP2PIncomeConfirm = isP2P && !isDebit && transaction.isIncome && !transaction.oneOff && !isReimbursed && !tracked;
  // The debit counterpart to needsP2PIncomeConfirm above — a P2P debit's
  // merchant text carries no bucket/category signal, so
  // categorizeUncategorizedTransactions (simplefin-sync.ts) runs a
  // history-informed guess but never auto-commits it, only ever a hint
  // (2026-08-23 household request: "confirm AI-suggested bucket and
  // category," mirroring this exact income-confirm pattern). Requires a
  // bucket guess specifically (not just a category one) since
  // reassignTransaction's bucket branch needs a real bucketId to submit —
  // a category-only guess with no bucket just sits as a Reclassify pre-fill
  // instead, no separate Confirm affordance for that narrower case.
  const needsP2PDebitConfirm = isP2P && isDebit && !tracked && Boolean(transaction.aiSuggestedBucketId);
  // "Confirmed as plain one-time income" — isIncome:true set explicitly
  // (oneOff:true) rather than just the sync-time default, and not itself a
  // reimbursement. Nothing left to reclassify at that point, same as
  // `tracked`/isDebtTransfer below.
  const isConfirmedPlainIncome = transaction.isIncome && transaction.oneOff && !isReimbursed && !hasOffsets;

  const { p2pApp, p2pTitle, displayMerchant: p2pDisplayMerchant, logoMerchant: p2pLogoMerchant } =
    deriveP2PDisplay(transaction);
  // A BNPL installment charge titles as its plan name (the schedule position
  // shows separately, at the end of the subline — see installmentSuffix
  // below); the logo keys off that same plan name, not the bare "Klarna"
  // descriptor. Everything below still keys off `transaction.merchant` for
  // routing/detection — only the title changes.
  const displayMerchant = transaction.installmentTitle ?? p2pDisplayMerchant;
  const logoMerchant = transaction.installmentTitle ? (transaction.debtName ?? p2pLogoMerchant) : p2pLogoMerchant;

  // Recurring isn't in here — the subtitle below already shows a Repeat icon
  // whenever classification.icon === "recurring", so a second one in this
  // menu was pure duplication. When there's an editable target (a pattern or
  // a tracked income, not just a bill/debt-payment match), that same
  // subtitle icon is the click target instead (see its onClick below).
  const rowActions: RowAction[] = [];
  // A plain merchant refund is never "recurring" in the tracked-bill/income
  // sense — hidden alongside "Mark As Income" below (see isRefundCandidate).
  if (!tracked && !isReimbursed && !isRefundCandidate) {
    rowActions.push({
      key: "track",
      icon: CalendarClock,
      label: isP2P ? "Set Up a Recurring Pattern" : "Track As Recurring",
      tone: "emerald",
      // These panels live in the `expanded &&` block below (line ~622), not
      // the always-visible subline RowActions renders from — without also
      // forcing the row open, the trigger's own state flip has nowhere
      // visible to show up (real report, 2026-09-05: tapping "Move" just
      // closed the actions drawer with no apparent effect). keepOpen: this
      // action opens a panel rather than finishing anything, so the drawer
      // shouldn't snap shut right back — only the X (or the opened panel's
      // own successful submit) should close it (same household report).
      keepOpen: true,
      onClick: () => {
        setTracking((v) => !v);
        setExpanded(true);
      },
    });
  }
  if (isDebit) {
    rowActions.push({
      key: "move",
      icon: LogOut,
      label: "Move",
      keepOpen: true,
      onClick: () => {
        setReclassifying((v) => !v);
        setExpanded(true);
      },
    });
  } else if (needsP2PIncomeConfirm) {
    // The default (isIncome:true, unconfirmed) already covers 99% of P2P
    // credits — this just confirms it as plain one-time income
    // (oneOff:true) instead of making the household pick from a dropdown.
    // Reimbursement/recurring income are the other two paths, offered right
    // alongside via ReimbursementLinker and the CalendarClock action above —
    // reassignTransaction({income:true}) is exactly the same action the old
    // "Mark as income" button used, it just also confirms an
    // already-defaulted isIncome:true.
    rowActions.push({
      key: "confirm-income",
      icon: Check,
      label: "Confirm As Income",
      tone: "emerald",
      disabled: markIncomePending,
      successToast: "Confirmed As Income",
      onClick: () => startMarkIncome(() => reassignTransaction(transaction.id, { income: true })),
    });
  } else if (!transaction.isIncome && !isDebtTransfer && !isReimbursed && !isRefundCandidate) {
    rowActions.push({
      key: "mark-income",
      icon: DollarSign,
      label: "Mark As Income",
      tone: "emerald",
      disabled: markIncomePending,
      successToast: "Marked As Income",
      onClick: () => startMarkIncome(() => reassignTransaction(transaction.id, { income: true })),
    });
  }
  // Same gate ReimbursementLinker itself renders under below (a decided
  // credit tells its own story inline instead — see isReimbursed/hasOffsets)
  // — buried in the subline as its own small "Link" button before (real
  // household report, 2026-09-05: hard to notice, and its dropdown painted
  // behind the row below it — see row-actions.tsx/select-field.tsx z-index
  // notes), same fix as Move/Track: a kebab action that opens the row and
  // reveals the panel, closed only by the X or a successful pick/dismiss.
  if (!isDebit && !isDebtTransfer && !tracked && !isReimbursed && !hasOffsets && !isConfirmedPlainIncome) {
    rowActions.push({
      key: "link",
      icon: Link2,
      label: "Link To A Purchase",
      keepOpen: true,
      onClick: () => {
        setLinkingOpen((v) => !v);
        setExpanded(true);
      },
    });
  }

  const { trigger: labelTrigger, panel: labelPanel } = useTransactionLabelEditor(
    transaction.id,
    transaction.label,
    labelSuggestions,
  );

  return (
    <li ref={rowRef} className="relative rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-2 text-sm">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        aria-expanded={expanded}
        className="w-full cursor-pointer text-left"
      >
        <p className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-medium text-neutral-900 dark:text-neutral-100">
            <MerchantLogo merchant={logoMerchant} size={16} allowGuess={!p2pApp} />
            <span className="shrink-0">{displayMerchant}</span>
            {transaction.pending && (
              <Clock
                size={12}
                className="shrink-0 text-amber-700 dark:text-amber-400"
                aria-label="Pending"
              />
            )}
            {transaction.hasReceipt && (
              <Receipt
                size={12}
                className="shrink-0 text-emerald-700 dark:text-emerald-400"
                aria-label="Has Attached Receipt"
              />
            )}
            {/* A credit linked to the purchase it refunds (or to a bare
                merchant when the exact charge wasn't pinned down) — the same
                green link glyph a reimbursement pattern carries
                (pattern-row.tsx), so a refund reads as one at a glance
                without expanding it (2026-09-20 household request). */}
            {isReimbursed && (
              <span className="flex shrink-0" title="Linked Refund">
                <Link2 size={12} className="text-emerald-700 dark:text-emerald-400" aria-label="Linked Refund" />
              </span>
            )}
            {/* The charge-side counterpart of the badge above — someone paid
                this back, shown right on the row so it reads at a glance
                without expanding it (2026-09-24 household report: a Verizon
                bill a Venmo payment reimbursed showed no indication of it). */}
            {wasReimbursed && (
              <span className="flex shrink-0" title="Reimbursed">
                <Link2 size={12} className="text-emerald-700 dark:text-emerald-400" aria-label="Reimbursed" />
              </span>
            )}
            {hasOffsets && (
              <span className="flex shrink-0" title={offsetSummary}>
                <Scissors
                  size={12}
                  className="text-amber-700 dark:text-amber-400"
                  aria-label={offsetSummary}
                />
              </span>
            )}
            {labelTrigger}
          </span>
          <span
            className={`shrink-0 font-medium ${isDebit ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}
          >
            {isDebit ? "-" : ""}
            {formatCents(Math.abs(transaction.amountCents))}
          </span>
        </p>
        {labelPanel}
        <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">
          <RowActions
            dense
            actions={rowActions}
            open={actionsOpen}
            // While Move/Track/Link's own panel is open below, an incidental
            // tap elsewhere on the page (scrolling a long list, mis-tapping
            // near the bottom) must not collapse it out from under a
            // half-filled form — only the X (or the panel's own successful
            // submit) should (household report, 2026-09-11: this exact
            // scenario, assigning a bucket at the bottom of /transactions).
            // `pinned` exists on RowActions for exactly this, just wasn't
            // wired up here yet.
            pinned={reclassifying || tracking || linkingOpen}
            extraBoundaryRef={rowRef}
            onOpenChange={(v) => {
              setActionsOpen(v);
              // The X closes the drawer *and* whatever panel it opened —
              // otherwise closing just the drawer leaves Move/Track's panel
              // stranded open with no trigger left visible to close it.
              if (!v) {
                setReclassifying(false);
                setTracking(false);
                setLinkingOpen(false);
              }
            }}
          >
          <span>
          {formatDate(transaction.occurredOn, { month: "short", day: "numeric" })}
          {transaction.accountLabel && ` · ${transaction.accountLabel}`}
          {isReimbursed ? (
            <span className="text-emerald-700 dark:text-emerald-400"> · {isP2P ? "Reimbursement" : "Refund"}</span>
          ) : (
            classification && (
              <>
                {/* Separator lives on the <p>, not inside the inline-flex span
                    below — flexbox trims an anonymous item's leading
                    whitespace, which ate the space before the middot. */}
                {" · "}
                <span
                  className={`inline-flex items-center gap-1 align-bottom ${classification.amber ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}
                >
                  {classification.icon === "debt" && <CreditCard size={11} className="shrink-0" />}
                  {classification.icon === "recurring" &&
                    (transaction.pattern ? (
                      // A RecurringPattern (not a bill/debt-payment/income match) is
                      // the one recurring source with no other page it's guaranteed
                      // to be editable from (see debt-targeted patterns' compact
                      // DebtRow link) — clicking here opens that edit/delete panel
                      // directly, reusing PatternFields the same way PatternRow does.
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingPattern((v) => !v);
                          setExpanded(true);
                        }}
                        aria-label={editingPattern ? "Close Pattern Editor" : "Edit Recurring Pattern"}
                        title="Recurring — click to edit"
                        className="shrink-0"
                      >
                        <Repeat size={11} />
                      </button>
                    ) : transaction.income ? (
                      // Matched a tracked Income (matchIncomePayments) — opens the
                      // same edit form IncomeRow's own pencil does
                      // (src/app/income/income-row.tsx), pre-filled, via
                      // updateIncome bound to this Income's id.
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingIncome((v) => !v);
                          setExpanded(true);
                        }}
                        aria-label={editingIncome ? "Close Income Editor" : "Edit Recurring Income"}
                        title="Recurring — click to edit"
                        className="shrink-0"
                      >
                        <Repeat size={11} />
                      </button>
                    ) : (
                      <Repeat size={11} className="shrink-0" aria-label="Recurring" />
                    ))}
                  {classification.text}
                </span>
              </>
            )
          )}
          {transaction.installmentSuffix && ` · ${transaction.installmentSuffix}`}
          </span>
          </RowActions>
        </p>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
          {needsP2PDebitConfirm && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20 px-3 py-2">
              <span className="min-w-0 truncate text-xs text-emerald-700 dark:text-emerald-400">
                AI guess:{" "}
                {[
                  buckets.find((b) => b.id === transaction.aiSuggestedBucketId)?.name,
                  categories.find((c) => c.id === transaction.aiSuggestedCategoryId)?.name,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <button
                onClick={() =>
                  startTransition(async () => {
                    if (!transaction.aiSuggestedBucketId) return;
                    await preservingScroll(() =>
                      reassignTransaction(transaction.id, {
                        bucketId: transaction.aiSuggestedBucketId!,
                        categoryId: transaction.aiSuggestedCategoryId,
                      }),
                    );
                    showToast("Transaction Moved");
                  })
                }
                disabled={pending}
                aria-label="Confirm AI-Suggested Bucket and Category"
                title="Confirm"
                className="shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {pending ? "…" : "Confirm"}
              </button>
            </div>
          )}
          {(transaction.notes || transaction.pending || bankDescription) && (
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              {transaction.pending && <span className="text-amber-700 dark:text-amber-400">Pending</span>}
              {transaction.pending && transaction.notes ? " · " : ""}
              {transaction.notes}
              {bankDescription && (transaction.pending || transaction.notes) ? " · " : ""}
              {bankDescription}
            </p>
          )}

          <ReceiptDetailBlock
            hasReceipt={transaction.hasReceipt}
            receiptItems={transaction.receiptItems}
            receiptNote={transaction.receiptNote}
            receiptPaidWith={transaction.receiptPaidWith}
            receiptDate={transaction.receiptDate}
            receiptTotalCents={transaction.receiptTotalCents}
            p2pTitle={p2pTitle}
          />

          {/* Read-only counterpart of ReimbursementLinker's own linked-state
              row below (which tells this same story from the credit's side,
              "Reimburses X") — the link lives on the credit, so unlinking
              happens from its row, not here. */}
          {wasReimbursed &&
            transaction.reimbursedBy.map((r) => (
              <p key={r.id} className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                <Link2 size={12} className="shrink-0" />
                Reimbursed by {r.merchant} · {formatCents(Math.abs(r.amountCents))} ·{" "}
                {formatDate(r.occurredOn, { month: "short", day: "numeric" })}
              </p>
            ))}

          {receiptMismatch && (
            <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle size={12} className="shrink-0" />
              Receipt Shows {formatCents(transaction.receiptTotalCents!)}, {formatCents(Math.abs(transaction.amountCents))} Charged
            </p>
          )}

          {!transaction.receiptItems?.length && !transaction.receiptNote && transaction.receiptSuggestion && (
            <div
              className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/20"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <span className="min-w-0 text-xs text-amber-800 dark:text-amber-300">
                Attach receipt
                {(() => {
                  const s = transaction.receiptSuggestion!;
                  const who = s.p2pApp
                    ? `${s.p2pApp}${s.party ? ` · ${s.party}` : ""}`
                    : s.party;
                  return who ? ` from ${who}` : "";
                })()}
                {transaction.receiptSuggestion.noteText
                  ? ` · "${transaction.receiptSuggestion.noteText}"`
                  : transaction.receiptSuggestion.itemSummary
                    ? ` · ${transaction.receiptSuggestion.itemSummary}`
                    : ""}
                ?
              </span>
              <span className="flex shrink-0 gap-1.5">
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await linkReceiptToTransaction(transaction.receiptSuggestion!.id, transaction.id);
                      showToast("Receipt Attached");
                    })
                  }
                  disabled={pending}
                  className="rounded-lg bg-blue-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-blue-700"
                >
                  Attach
                </button>
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await dismissReceipt(transaction.receiptSuggestion!.id);
                      showToast("Dismissed");
                    })
                  }
                  disabled={pending}
                  aria-label="Not This Charge"
                  title="Not This Charge"
                  className="rounded-lg border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-400"
                >
                  <X size={13} />
                </button>
              </span>
            </div>
          )}


          {!isDebit && !isDebtTransfer && !tracked && !isConfirmedPlainIncome && (
            <ReimbursementLinker
              transactionId={transaction.id}
              merchant={transaction.merchant}
              bucketName={transaction.bucketName}
              creditAmountCents={Math.abs(transaction.amountCents)}
              suggestions={reimbursementSuggestions}
              buckets={transaction.accountBudgetTracked ? buckets : []}
              linked={
                transaction.reimbursesTransaction
                  ? {
                      id: transaction.reimbursesTransaction.id,
                      merchant: transaction.reimbursesTransaction.merchant,
                      amountCents: transaction.reimbursesTransaction.amountCents,
                      occurredOn: transaction.reimbursesTransaction.occurredOn.toISOString().slice(0, 10),
                    }
                  : null
              }
              linkedMerchant={transaction.reimbursesMerchant}
              offsets={transaction.offsets}
              dismissed={transaction.refundReviewDismissed}
              allowSplit={!isRefundCandidate}
              open={linkingOpen}
              onOpenChange={setLinkingOpen}
            />
          )}

          {editingPattern && transaction.pattern && (
            <form
              action={patternFormAction}
              className="flex flex-col gap-3 border-t border-blue-100 dark:border-neutral-800 pt-2"
            >
              <PatternFields
                buckets={transaction.accountBudgetTracked ? buckets : []}
                debts={debts}
                bills={bills}
                categories={categories}
                lockedChannelKeyword={transaction.pattern.channelKeyword}
                lockedDirection={transaction.pattern.direction}
                defaults={{
                  label: transaction.pattern.label,
                  channelKeyword: transaction.pattern.channelKeyword,
                  amountMin: (transaction.pattern.amountMinCents / 100).toString(),
                  amountMax: (transaction.pattern.amountMaxCents / 100).toString(),
                  // The scheduled-form's single Amount field — same midpoint
                  // convention as PatternRow's own edit form.
                  amount: (Math.round((transaction.pattern.amountMinCents + transaction.pattern.amountMaxCents) / 2) / 100).toString(),
                  dayOfMonthStart: transaction.pattern.dayOfMonthStart?.toString() ?? "",
                  dayOfMonthEnd: transaction.pattern.dayOfMonthEnd?.toString() ?? "",
                  weekdays: transaction.pattern.weekdays,
                  target: transaction.pattern.bucketId
                    ? `bucket:${transaction.pattern.bucketId}`
                    : transaction.pattern.debtId
                      ? `debt:${transaction.pattern.debtId}`
                      : "",
                  countsAsIncome: transaction.pattern.countsAsIncome,
                  billId: transaction.pattern.billId ?? "",
                  categoryId: transaction.pattern.categoryId ?? "",
                  // These five were missing entirely (real bug, 2026-09-11):
                  // opening this panel — the Repeat icon's edit view, as
                  // opposed to PatternRow's own — rendered every scheduled
                  // pattern as if it had never been scheduled, and any save
                  // from here would have silently wiped counterpartyName/
                  // noteKeywords/cadence/nextDueDate/toleranceCents right
                  // back to null.
                  counterpartyName: transaction.pattern.counterpartyName ?? undefined,
                  noteKeywords: transaction.pattern.noteKeywords,
                  cadence: transaction.pattern.cadence ?? undefined,
                  nextDueDate: transaction.pattern.nextDueDate ?? undefined,
                  tolerance:
                    transaction.pattern.toleranceCents !== null
                      ? (transaction.pattern.toleranceCents / 100).toString()
                      : undefined,
                }}
              />
              {patternState.error && <p className="text-sm text-red-600 dark:text-red-400">{patternState.error}</p>}
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (!transaction.pattern) return;
                    if (!confirm(`Delete "${transaction.pattern.label}"?`)) return;
                    startDeletePattern(async () => {
                      try {
                        await deletePattern(transaction.pattern!.id);
                        showToast("Pattern Deleted");
                      } catch {
                        showToast("Something Went Wrong", "error");
                      }
                    });
                  }}
                  disabled={deletePatternPending}
                  className="text-sm font-medium text-red-600 dark:text-red-400 disabled:opacity-50"
                >
                  {deletePatternPending ? "Deleting…" : "Delete Pattern"}
                </button>
                <button
                  type="submit"
                  disabled={patternPending}
                  aria-label="Save"
                  title="Save"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white disabled:opacity-50 dark:bg-blue-700"
                >
                  {patternPending ? <span aria-hidden>…</span> : <Check size={15} />}
                </button>
              </div>
            </form>
          )}

          {editingIncome && transaction.income && (
            <form
              action={(formData) => {
                incomeFormAction(formData);
                setEditingIncome(false);
              }}
              className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2"
            >
              <input
                name="name"
                defaultValue={transaction.income.name}
                required
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
              <div className="flex gap-2">
                <MoneyInput
                  name="amount"
                  defaultCents={transaction.income.amountCents}
                  required
                  className="w-28 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
                <SelectField
                  name="cadence"
                  value={incomeCadence}
                  onChange={(v) => setIncomeCadence(v as typeof incomeCadence)}
                  searchable={false}
                  options={[
                    { value: "BIWEEKLY", label: INCOME_CADENCE_LABEL.BIWEEKLY },
                    { value: "SEMI_MONTHLY", label: INCOME_CADENCE_LABEL.SEMI_MONTHLY },
                    { value: "MONTHLY", label: INCOME_CADENCE_LABEL.MONTHLY },
                  ]}
                  className="flex-1"
                />
              </div>
              <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                Next Pay Date
                <input
                  name="nextPayDate"
                  type="date"
                  defaultValue={transaction.income.nextPayDate ? transaction.income.nextPayDate.toISOString().slice(0, 10) : ""}
                  className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
              </label>
              {incomeState.error && <p className="text-xs text-red-600 dark:text-red-400">{incomeState.error}</p>}
              <InlineSaveButton pending={incomePending} justSaved={incomeJustSaved} />
            </form>
          )}

          {tracking && (isP2P ? (
            <PatternPanel
              txn={{
                id: transaction.id,
                merchant: transaction.merchant,
                amountCents: transaction.amountCents,
                occurredOn: transaction.occurredOn.toISOString().slice(0, 10),
                resolvedMerchant: transaction.resolvedMerchant,
                receiptNote: transaction.receiptNote,
              }}
              buckets={transaction.accountBudgetTracked ? buckets : []}
              debts={debts}
              bills={bills}
              categories={categories}
              defaultCategoryId={transaction.aiSuggestedCategoryId ?? undefined}
              direction={isDebit ? "DEBIT" : "CREDIT"}
              onDone={() => {
                setTracking(false);
                setTracked(true);
                setActionsOpen(false);
              }}
            />
          ) : (
            <TrackAsBillForm
              transactionId={transaction.id}
              defaultName={transaction.merchant}
              defaultAmountCents={transaction.amountCents}
              categories={categories}
              debts={debts}
              existingBills={bills}
              buckets={transaction.accountBudgetTracked ? buckets : []}
              allowBill={transaction.accountBudgetTracked}
              onDone={() => {
                setTracking(false);
                setTracked(true);
                setActionsOpen(false);
              }}
              onCancel={() => {
                setTracking(false);
                setActionsOpen(false);
              }}
            />
          ))}

          {isDebit && reclassifying && (
            <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
              <div className="flex items-center gap-2">
                <SelectField
                  value={selection}
                  onChange={setSelection}
                  small
                  searchable={false}
                  options={[
                    // RECURRING buckets are excluded here — a plain Move can
                    // only ever set bucketId directly, which the server
                    // rejects for a RECURRING bucket (see the guard in
                    // reassignTransaction). Routing something into a bill
                    // bucket goes through "Track as a recurring transaction"
                    // (the CalendarClock icon above) instead, which creates a
                    // real RecurringBill via TrackAsBillForm.
                    ...(transaction.accountBudgetTracked
                      ? buckets
                          .filter((b) => b.trackingMode !== "RECURRING")
                          .map((b) => ({ value: `bucket:${b.id}`, label: b.name, group: "Bucket" }))
                      : []),
                    ...trackedDebts.map((d) => ({ value: `debt:${d.id}`, label: d.name, group: "Debt Payment" })),
                  ]}
                  className="min-w-0 flex-1"
                />
                {transaction.accountBudgetTracked && selection.startsWith("bucket:") && (
                  <div className="w-32 shrink-0">
                    <CategoryPicker
                      key={selection}
                      categories={categories.filter((c) => c.bucketId === selection.slice("bucket:".length))}
                      defaultCategoryId={categoryId}
                      bucketId={selection.slice("bucket:".length)}
                      onSelect={setCategoryId}
                      small
                    />
                  </div>
                )}
                <button
                  onClick={() =>
                    startTransition(async () => {
                      if (showRouting && routeBounded) {
                        setRouteError(null);
                        const res = await setAmountRoutingRule({
                          merchant: transaction.merchant,
                          bucketId: selId,
                          categoryId,
                          amountDollars: boundedMax,
                          direction: routeDirection,
                        });
                        if (res?.error) {
                          setRouteError(res.error);
                          return;
                        }
                        setReclassifying(false);
                        setActionsOpen(false);
                        showToast("Routing Rule Saved");
                        return;
                      }
                      await preservingScroll(() =>
                        reassignTransaction(
                          transaction.id,
                          selKind === "debt" ? { debtId: selId } : { bucketId: selId, categoryId },
                          // Only override the server default for a genuine
                          // re-bucketing — a first-time assignment keeps learning
                          // the rule on its own.
                          isRebucketing ? { learnRule: makeRule } : undefined,
                        ),
                      );
                      setReclassifying(false);
                      setActionsOpen(false);
                      showToast("Transaction Moved");
                    })
                  }
                  disabled={pending || !selection}
                  className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {pending ? "…" : showRouting && routeBounded ? "Route" : "Move"}
                </button>
              </div>
              {showRouting && (
                <AmountRoutingToggle
                  merchant={transaction.merchant}
                  enabled={routeBounded}
                  onEnabledChange={setRouteBounded}
                  direction={routeDirection}
                  onDirectionChange={setRouteDirection}
                  amountDollars={boundedMax}
                  onAmountDollarsChange={setBoundedMax}
                />
              )}
              {isRebucketing && !routeBounded && (
                <MakeRuleToggle merchant={transaction.merchant} enabled={makeRule} onEnabledChange={setMakeRule} />
              )}
              {routeError && <p className="text-xs text-red-600 dark:text-red-400">{routeError}</p>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
