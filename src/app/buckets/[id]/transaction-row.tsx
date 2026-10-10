"use client";

import { useRef, useState, useTransition } from "react";
import { Check, Link2, LogOut, Receipt } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { showToast } from "@/lib/toast";
import type { ReceiptLineItem } from "@/app/transactions/transaction-row";
import { reassignTransaction, setAmountRoutingRule } from "../actions";
import { useTransactionLabelEditor } from "@/components/transaction-label-editor";
import { MerchantLogo } from "@/components/merchant-logo";
import { PendingIcon } from "@/components/pending-icon";
import { ReceiptDetailBlock } from "@/components/receipt-detail-block";
import { deriveP2PDisplay, bankDescriptionFor } from "@/lib/transaction-display";
import { MoveTargetPicker } from "@/components/move-target-picker";
import { ReimbursementLinker, type ReimbursementCandidate } from "@/components/reimbursement-linker";
import { type CategoryOption } from "@/app/bills/category-picker";
import { AmountRoutingToggle, MakeRuleToggle, suggestRoutingMax, type RoutingDirection } from "@/components/amount-routing-toggle";
import { isP2PMerchant } from "@/lib/p2p-keywords";
import { useEntryFilter } from "@/components/bucket-entry-filter";
import { RowActions } from "@/components/row-actions";

type BucketOption = { id: string; name: string; trackingMode: "SPEND" | "RECURRING" | "MIXED" };
type DebtOption = { id: string; name: string };

export function TransactionRow({
  transaction,
  merchant,
  buckets,
  currentBucketId,
  debts,
  categories,
  labelSuggestions = [],
  reimbursementSuggestions = [],
}: {
  // The bucket page's filter/breakdown effective merchant key (merchantKeyOf
  // in page.tsx — the same P2P-aware resolution the "Spending by Merchant"
  // wedges and the Singles "N of M" count use, e.g. a Venmo payment's
  // parsed-out counterparty name rather than the raw "Venmo" bank merchant).
  // Kept as its own prop rather than re-derived from `transaction.merchant`
  // here so this row can never drift from what the count above it already
  // decided — that drift is exactly what hid a filtered-in P2P row entirely
  // (2026-09-24 real report: filter said "1 of 64", the row never rendered).
  merchant: string;
  transaction: {
    id: string;
    merchant: string;
    amountCents: number;
    occurredOn: Date;
    notes: string | null;
    label: string | null;
    categoryId: string | null;
    reimbursesTransaction: { id: string; merchant: string; amountCents: number; occurredOn: Date } | null;
    reimbursesMerchant: string | null;
    // Shown only in the expanded detail view, same split as /transactions'
    // own TransactionRow — `pending` is SimpleFIN's "not settled yet" flag,
    // `rawDescription` its raw bank line (null for anything synced before
    // that field existed).
    pending: boolean;
    rawDescription: string | null;
    // A receipt is linked to this transaction — drives the small receipt
    // glyph in the row title, same as /transactions' TransactionRow.
    hasReceipt: boolean;
    // --- Email-receipt enrichment (see src/lib/receipt-sync.ts) — same
    // "Venmo · Name" title + "From Receipt" block that /transactions'
    // TransactionRow shows. These fields are frozen onto the transaction by
    // linkReceipt and survive even if the Receipt row is later purged, so a
    // P2P charge keeps reading "Venmo · Hoops Academy" rather than the
    // opaque "Transfer to Venmo" bank descriptor. `merchant` still drives all
    // the P2P/rule/routing detection below — only the displayed title changes.
    resolvedMerchant: string | null;
    resolvedMerchantIsPerson: boolean;
    receiptPaidWith: string | null;
    receiptNote: string | null;
    receiptTotalCents: number | null;
    receiptItems: ReceiptLineItem[] | null;
    // The linked receipt's own date ("YYYY-MM-DD"), for the bare-match line.
    receiptDate: string | null;
  };
  buckets: BucketOption[];
  // The bucket this Singles list belongs to — included in `buckets` and
  // shown as "(Current)" so a transaction can have just its category
  // changed without leaving the bucket.
  currentBucketId: string;
  debts: DebtOption[];
  categories: CategoryOption[];
  labelSuggestions?: string[];
  reimbursementSuggestions?: ReimbursementCandidate[];
}) {
  // Same collapsed/expanded card as /transactions' own TransactionRow
  // (2026-08-26 household request: "single entries should look like
  // transaction cards") — click the top line to open the detail/edit view.
  // Deliberately no bucket/category line in the collapsed meta: you're
  // already inside the bucket, and the tag icon carries the category.
  const [expanded, setExpanded] = useState(false);
  // The Move/reclassify control is its own collapsible panel behind the
  // kebab's "Move" action — not just part of the expanded detail (household
  // request, 2026-09-08). Same pattern as /transactions' TransactionRow:
  // `actionsOpen` drives RowActions' drawer from out here so the X can
  // collapse the panel with it, and `moveOpen` is the panel's own toggle
  // (Move again / a successful save also close it).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  // ReimbursementLinker's panel visibility lives with its caller now (see
  // its own props doc) — this simpler page has no row-actions kebab to hang
  // the trigger on (unlike /transactions' own TransactionRow), so it keeps
  // its own local trigger button right below instead.
  const [linkingOpen, setLinkingOpen] = useState(false);
  // Default to the current bucket so opening the picker lands on "change
  // this transaction's category" rather than "move it somewhere else."
  const [selection, setSelection] = useState(
    buckets.some((b) => b.id === currentBucketId)
      ? `bucket:${currentBucketId}`
      : buckets[0]
        ? `bucket:${buckets[0].id}`
        : debts[0]
          ? `debt:${debts[0].id}`
          : "",
  );
  const [categoryId, setCategoryId] = useState<string | null>(transaction.categoryId);
  const [pending, startTransition] = useTransition();
  const [moved, setMoved] = useState(false);
  // "Only route this merchant here under $X" — writes an amount-bounded
  // merchant rule instead of overwriting the merchant's base rule (which a
  // plain Move does), so small charges peel off without dragging the
  // fill-ups with them.
  const [routeBounded, setRouteBounded] = useState(false);
  const [routeDirection, setRouteDirection] = useState<RoutingDirection>("under");
  const [boundedMax, setBoundedMax] = useState(() => suggestRoutingMax(transaction.amountCents));
  const [routeError, setRouteError] = useState<string | null>(null);
  // Opt-in, off by default — a plain Move just corrects this one transaction
  // and leaves the household's merchant rule alone.
  const [makeRule, setMakeRule] = useState(false);
  const { trigger: labelTrigger, panel: labelPanel } = useTransactionLabelEditor(
    transaction.id,
    transaction.label,
    labelSuggestions,
  );
  const isP2P = isP2PMerchant(transaction.merchant);

  const { p2pApp, p2pTitle, displayMerchant, logoMerchant } = deriveP2PDisplay(transaction);

  // Category tag tucked behind a hover/tap tag icon, same treatment as the
  // recurring cards (BillRow / DebtPaymentCard) render alongside these in
  // BucketBillsSection (2026-08-26 household request: put the tag icon on
  // every transaction card, not just the recurring ones). Name resolved
  // from the household category list — the plain transactions query on this
  // page carries only categoryId, not the joined record.
  const categoryName = transaction.categoryId
    ? (categories.find((c) => c.id === transaction.categoryId)?.name ?? null)
    : null;
  // `categories` is the full household-wide list (needed as-is by the
  // CategoryPicker below, which can target a *different* bucket once this
  // row's own Move dropdown picks one) — but "does this specific bucket
  // even have categories" has to be asked against just this bucket's own
  // subset, or a household with categories set up anywhere at all would
  // never see this suppressed (real report, 2026-09-07: deleted Amazon's
  // two categories, "Uncategorized" kept showing anyway).
  const currentBucketHasCategories = categories.some((c) => c.bucketId === currentBucketId);

  // Bucket page's spend-breakdown filter (BucketEntryFilterProvider) — hides
  // this row when a category/merchant filter is active and it doesn't match,
  // and tints its left edge with the matched filter's color.
  const { hidden, barClass } = useEntryFilter(categoryName, merchant);

  if (moved || hidden) return null;

  const isDebit = transaction.amountCents > 0;
  // Linked to the purchase it refunds, or to a bare merchant — same test as
  // /transactions' TransactionRow. Drives the collapsed row's green link icon.
  const isReimbursed = Boolean(transaction.reimbursesTransaction || transaction.reimbursesMerchant);
  const [selKind, selId] = selection.split(":");
  const isBucketMove = selKind === "bucket" && selId !== currentBucketId;
  const showRouting = isBucketMove && !isP2P;
  // A pick that stays in this bucket is just a category tweak — the commit
  // button is a plain Save (a checkmark). Anything else is a Move (or a
  // bounded-amount Route), spelled out.
  const isSameBucketSave = selection === `bucket:${currentBucketId}`;
  const moveButtonLabel = showRouting && routeBounded ? "Route" : "Move";
  const bankDescription = bankDescriptionFor(transaction);

  return (
    <li
      ref={rowRef}
      className={`relative rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-2 text-sm ${barClass}`}
    >
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
            <MerchantLogo
              merchant={logoMerchant}
              size={16}
              allowGuess={!p2pApp}
              // Not for a P2P transfer: its raw text carries a person's name.
              description={p2pApp ? null : transaction.rawDescription}
            />
            <span className="shrink-0">{displayMerchant}</span>
            {transaction.pending && <PendingIcon />}
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
            open={actionsOpen}
            // See the identical fix in /transactions' TransactionRow
            // (2026-09-11) — an incidental tap elsewhere on the page while
            // the Move panel is open must not collapse it out from under a
            // half-filled form.
            pinned={moveOpen}
            extraBoundaryRef={rowRef}
            onOpenChange={(v) => {
              setActionsOpen(v);
              // The X closes the drawer and the Move panel together.
              if (!v) setMoveOpen(false);
            }}
            actions={
              buckets.length > 0 || debts.length > 0
                ? [
                    {
                      key: "move",
                      icon: LogOut,
                      label: "Move",
                      keepOpen: true,
                      onClick: () => {
                        setMoveOpen((v) => !v);
                        setExpanded(true);
                      },
                    },
                  ]
                : []
            }
          >
            <span>
              {formatDate(transaction.occurredOn, { month: "short", day: "numeric" })}
              {/* Category shown in green right by the date, same treatment as
                  /transactions' own meta line — no bucket name here, we're
                  already inside the bucket. Edit it from the expanded panel.
                  A bucket with no categories at all (Amazon, say — nothing
                  to split it into) has nothing to flag here: every one of
                  its transactions would trivially read "Uncategorized" in
                  amber forever, which reads as an unresolved problem rather
                  than the simple fact that this bucket was never meant to
                  have sub-categories (real household report, 2026-09-07). */}
              {categoryName ? (
                <>
                  {" · "}
                  <span className="text-emerald-700 dark:text-emerald-400">{categoryName}</span>
                </>
              ) : (
                currentBucketHasCategories && (
                  <>
                    {" · "}
                    <span className="text-amber-700 dark:text-amber-400">Uncategorized</span>
                  </>
                )
              )}
            </span>
          </RowActions>
        </p>
      </div>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
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

          {transaction.amountCents < 0 && (
            <div className="flex flex-col gap-1.5">
              {!transaction.reimbursesTransaction && !transaction.reimbursesMerchant && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLinkingOpen((v) => !v);
                  }}
                  className="flex w-fit items-center gap-1 text-xs text-blue-900 dark:text-blue-300"
                >
                  {linkingOpen ? "Cancel" : "Link"}
                </button>
              )}
              <ReimbursementLinker
                transactionId={transaction.id}
                merchant={transaction.merchant}
                creditAmountCents={Math.abs(transaction.amountCents)}
                suggestions={reimbursementSuggestions}
                buckets={buckets}
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
                open={linkingOpen}
                onOpenChange={setLinkingOpen}
              />
            </div>
          )}

          {moveOpen && (buckets.length > 0 || debts.length > 0) && (
            <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
              <div className="flex items-center gap-2">
                {/* RECURRING buckets excluded — a plain Move sets bucketId
                    directly, which the server rejects for one (see the guard
                    in reassignTransaction); moving something into a bill
                    bucket has to go through the bill-tracking flow instead
                    (/transactions' "Track as a recurring transaction"). */}
                <MoveTargetPicker
                  selection={selection}
                  onSelectionChange={setSelection}
                  buckets={buckets.filter((b) => b.trackingMode !== "RECURRING")}
                  debts={debts}
                  categories={categories}
                  categoryId={categoryId}
                  onCategoryChange={setCategoryId}
                  currentBucketId={currentBucketId}
                />
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
                        setMoveOpen(false);
                        setActionsOpen(false);
                        setMoved(true);
                        showToast("Routing Rule Saved");
                        return;
                      }
                      await reassignTransaction(
                        transaction.id,
                        selKind === "debt" ? { debtId: selId } : { bucketId: selId, categoryId },
                        // Only a genuine move to another bucket honours the
                        // checkbox; a same-bucket category tweak keeps the
                        // server default (updates the rule's category).
                        isBucketMove && !isP2P ? { learnRule: makeRule } : undefined,
                      );
                      // Staying in this bucket (just a category change) — the
                      // row belongs here still, so let the revalidated page
                      // re-render it rather than hiding it. Either way the
                      // Move panel + kebab drawer collapse on a successful save.
                      setMoveOpen(false);
                      setActionsOpen(false);
                      showToast("Transaction Saved");
                      if (selKind === "debt" || selId !== currentBucketId) {
                        setMoved(true);
                      } else {
                        setExpanded(false);
                      }
                    })
                  }
                  disabled={pending || !selection}
                  aria-label={pending ? "Saving…" : isSameBucketSave ? "Save" : moveButtonLabel}
                  title={isSameBucketSave ? "Save" : moveButtonLabel}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white disabled:opacity-50 dark:bg-blue-700"
                >
                  {pending ? (
                    <span aria-hidden className="text-xs">…</span>
                  ) : isSameBucketSave ? (
                    // Same checkmark InlineSaveButton / the account & net-worth
                    // edit forms commit with — a same-bucket pick here is just a
                    // category tweak, i.e. a plain Save.
                    <Check size={15} />
                  ) : (
                    // The same LogOut glyph the kebab's "Move" action uses,
                    // for a real move or a bounded-amount Route.
                    <LogOut size={15} />
                  )}
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
              {isBucketMove && !isP2P && !routeBounded && (
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
