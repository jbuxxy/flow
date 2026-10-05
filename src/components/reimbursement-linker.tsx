"use client";

import { useState, useTransition } from "react";
import { Ban, Link2, Scissors, Search, Star, X } from "lucide-react";
import { formatCents } from "@/lib/money";
import { showToast } from "@/lib/toast";
import { formatDate } from "@/lib/date";
import { SelectField } from "@/components/select-field";
import { P2P_DISCOVERY_KEYWORDS } from "@/lib/p2p-keywords";
import {
  addTransactionOffset,
  dismissRefundReview,
  linkReimbursement,
  linkReimbursementToMerchant,
  removeTransactionOffset,
  searchLinkableDebits,
  searchOffsetTargets,
  unlinkReimbursement,
  type ReimbursementCandidate,
} from "@/app/transactions/actions";

export type { ReimbursementCandidate };

type BucketOption = { id: string; name: string };

export type LinkerOffset = {
  id: string;
  amountCents: number;
  debitMerchant: string;
  debitDebtName: string | null;
};

function CandidateButton({
  candidate,
  disabled,
  isBestMatch,
  onPick,
}: {
  candidate: ReimbursementCandidate;
  disabled: boolean;
  isBestMatch: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-left text-xs hover:border-blue-900 dark:hover:border-blue-400 disabled:opacity-50"
    >
      <span className="flex min-w-0 items-center gap-1 truncate">
        {isBestMatch && (
          <Star size={11} className="shrink-0 fill-amber-400 text-amber-400" aria-label="Best Match" />
        )}
        <span className="truncate">
          {candidate.debtName ?? candidate.merchant} ·{" "}
          {formatDate(new Date(candidate.occurredOn), { month: "short", day: "numeric" })}
        </span>
      </span>
      <span className="shrink-0 font-medium text-red-600 dark:text-red-400">
        -{formatCents(candidate.amountCents)}
      </span>
    </button>
  );
}

// The split panel: search a payment/payoff, pick it, enter how much of this
// credit goes toward it. Repeatable — one row per target, remainder stays
// income. See addTransactionOffset / TransactionOffset.
function SplitPanel({
  transactionId,
  remainingCents,
  onAdded,
  bordered = true,
}: {
  transactionId: string;
  remainingCents: number;
  onAdded: () => void;
  // False when the caller already wraps this in its own bordered box (see
  // the "open" panel below, which frames the mode toggle + SplitPanel
  // together) — otherwise you get a border nested inside an identical
  // border (real household report, 2026-09-17).
  bordered?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReimbursementCandidate[] | null>(null);
  const [searching, startSearch] = useTransition();
  const [picked, setPicked] = useState<ReimbursementCandidate | null>(null);
  const [amountStr, setAmountStr] = useState("");
  const [adding, startAdd] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pick = (c: ReimbursementCandidate) => {
    setPicked(c);
    setError(null);
    setAmountStr(((Math.min(c.amountCents, remainingCents)) / 100).toFixed(2));
  };

  const submit = () => {
    if (!picked) return;
    const amountCents = Math.round(parseFloat(amountStr) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setError("Enter an amount.");
      return;
    }
    startAdd(async () => {
      const res = await addTransactionOffset(transactionId, picked.id, amountCents);
      if (res && "error" in res && res.error) {
        setError(res.error);
        return;
      }
      // revalidatePath in the action refreshes `offsets` from the server;
      // just close up here.
      setPicked(null);
      setAmountStr("");
      setQuery("");
      setResults(null);
      onAdded();
      showToast("Offset Added");
    });
  };

  return (
    <div
      className={
        bordered
          ? "flex flex-col gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 p-2"
          : "flex flex-col gap-2"
      }
    >
      {picked ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-neutral-700 dark:text-neutral-300">
            Toward <span className="font-medium">{picked.debtName ?? picked.merchant}</span>
          </p>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-neutral-500">$</span>
            <input
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              inputMode="decimal"
              className="w-24 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-xs focus:border-blue-900 focus:outline-none"
            />
            <button
              onClick={submit}
              disabled={adding}
              className="rounded-lg bg-blue-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-blue-600"
            >
              Add
            </button>
            <button
              onClick={() => {
                setPicked(null);
                setError(null);
              }}
              className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              Back
            </button>
          </div>
          <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
            {formatCents(remainingCents)} left to allocate
          </p>
          {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      ) : (
        <>
          <input
            value={query}
            onChange={(e) => {
              const value = e.target.value;
              setQuery(value);
              startSearch(async () => setResults(value.trim() ? await searchOffsetTargets(value.trim()) : null));
            }}
            placeholder="Search a payment or payoff (e.g. Trailer, F150)…"
            className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
          />
          {searching && <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Searching…</p>}
          {results?.map((c) => (
            <CandidateButton key={c.id} candidate={c} disabled={adding} isBestMatch={false} onPick={() => pick(c)} />
          ))}
          {results !== null && results.length === 0 && !searching && (
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">No matches.</p>
          )}
        </>
      )}
    </div>
  );
}

// A credit's "link this to what it pays back" affordance — the manual half
// of returns/reimbursements. Suggestions (same-amount debits, computed
// server-side by getReimbursementSuggestions) are passed in as a prop
// rather than fetched on open, same convention as label-suggestion
// autocomplete elsewhere; the merchant search is the one part that has to
// be a live server action, since the full transaction list isn't something
// a page can reasonably pass down whole.
//
// Two shapes:
//  - whole-amount (linkReimbursement / linkReimbursementToMerchant) — the
//    entire credit pays back one debit / merchant, nets against its bucket;
//  - split (addTransactionOffset / TransactionOffset) — the credit is carved
//    into partial amounts against several payments, remainder stays income.
// They're mutually exclusive on a given credit (enforced server-side).
export function ReimbursementLinker({
  transactionId,
  merchant,
  bucketName = null,
  creditAmountCents = 0,
  suggestions,
  buckets = [],
  linked,
  linkedMerchant = null,
  offsets = [],
  dismissed = false,
  allowSplit = true,
  open,
  onOpenChange,
}: {
  transactionId: string;
  // The credit's own merchant text — most refunds post from the same
  // merchant that was originally charged, so the search box defaults to it
  // and auto-searches on open instead of starting blank. Optional only so
  // an older/other call site can't break; falls back to an empty search.
  merchant?: string;
  // The bucket this credit nets against, once linked (inherited from the
  // debit it pays back, or picked directly for a bare-merchant refund — see
  // linkReimbursement/linkReimbursementToMerchant). Shown alongside the
  // linked-state line below, which is the only place a linked transaction's
  // story gets told (see classificationLabel, transaction-row.tsx).
  bucketName?: string | null;
  // Absolute cents of the credit — drives the "$X still counts as income"
  // remainder line in split mode.
  creditAmountCents?: number;
  suggestions: ReimbursementCandidate[];
  buckets?: BucketOption[];
  linked: ReimbursementCandidate | null;
  linkedMerchant?: string | null;
  offsets?: LinkerOffset[];
  // Transaction.refundReviewDismissed — the household already looked and
  // said none of the candidates apply. See dismissRefundReview.
  dismissed?: boolean;
  // False for a refund candidate (see isRefundCandidate, transaction-row.tsx)
  // — carving a return into pieces across several debt payments isn't a
  // real thing a refund does (it pays back the one purchase it pays back,
  // full stop), unlike a paycheck or other lump credit, where splitting
  // across bills is the whole point. Hides the mode toggle entirely rather
  // than just disabling it, so "whole" is the only choice, silently, for
  // that case (real household request, 2026-09-06: "remove from refunds
  // actions").
  allowSplit?: boolean;
  // Panel visibility lives in transaction-row.tsx now, alongside Move/Track
  // (its own kebab action's the only trigger — real household report,
  // 2026-09-05: the old "Link" button lived buried in the subline instead of
  // the row's action menu). Always controlled — this component has exactly
  // one call site.
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"whole" | "split">("whole");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReimbursementCandidate[] | null>(null);
  const [merchantBucketId, setMerchantBucketId] = useState("");
  const [searching, startSearch] = useTransition();
  const [linking, startLink] = useTransition();
  const [current, setCurrent] = useState(linked);
  const [currentMerchant, setCurrentMerchant] = useState(linkedMerchant);
  const [isDismissed, setIsDismissed] = useState(dismissed);
  // Optimistically hide an offset the moment its X is clicked; the prop
  // refreshes from the server (revalidatePath) right after.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const visibleOffsets = offsets.filter((o) => !removedIds.has(o.id));

  const allocatedCents = visibleOffsets.reduce((s, o) => s + o.amountCents, 0);
  const remainingCents = Math.max(0, creditAmountCents - allocatedCents);

  if (current || currentMerchant) {
    // A person paying you back over Venmo/Zelle/etc. is a genuine
    // reimbursement; a merchant crediting its own purchase back (Amazon,
    // Walmart) reads better as a plain refund — same P2P_DISCOVERY_KEYWORDS
    // check TransactionRow uses for its own isP2P.
    const isP2P = P2P_DISCOVERY_KEYWORDS.some((k) => (merchant ?? "").toLowerCase().includes(k));
    const verb = isP2P ? "Reimburses" : "Refund from";
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        <Link2 size={12} className="shrink-0" />
        <span className="truncate">
          {current ? (
            <>
              {verb} {current.merchant} · {formatCents(current.amountCents)} ·{" "}
              {formatDate(new Date(current.occurredOn), { month: "short", day: "numeric" })}
            </>
          ) : (
            <>
              {verb} {currentMerchant} (unspecified purchase)
            </>
          )}
          {bucketName && <> → {bucketName}</>}
        </span>
        <button
          onClick={() => {
            if (
              !confirm(
                "Unlink this reimbursement? This credit goes back to needing a call on income vs. reimbursement, and the purchase/bill it points at stops counting it as paid back.",
              )
            )
              return;
            startLink(async () => {
              await unlinkReimbursement(transactionId);
              setCurrent(null);
              setCurrentMerchant(null);
              showToast("Reimbursement Unlinked");
            });
          }}
          disabled={linking}
          aria-label="Unlink"
          title="Unlink"
          className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  const pick = (candidate: ReimbursementCandidate) =>
    startLink(async () => {
      await linkReimbursement(transactionId, candidate.id);
      setCurrent(candidate);
      showToast("Reimbursement Linked");
      // Picking a match finishes the job — close the panel (and, via the
      // same onOpenChange the row's kebab drawer uses, the drawer with it),
      // same as Move/Track's own successful-submit behavior.
      onOpenChange(false);
    });

  if (isDismissed && !open && visibleOffsets.length === 0) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
        <Ban size={12} className="shrink-0" />
        <span>Not A Refund — Applied Nowhere</span>
        <button
          onClick={() =>
            startLink(async () => {
              setIsDismissed(false);
              await dismissRefundReview(transactionId, false);
            })
          }
          disabled={linking}
          aria-label="Undo"
          title="Undo — review this credit again"
          className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-blue-900 dark:hover:text-blue-300 disabled:opacity-50"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  const removeOffset = (id: string) =>
    startLink(async () => {
      setRemovedIds((prev) => new Set(prev).add(id));
      await removeTransactionOffset(id);
      showToast("Offset Removed");
    });

  const trimmedQuery = query.trim();
  // What a direct "apply to a bucket, skip the specific purchase" pick
  // records as reimbursesMerchant — the credit's own merchant by default (no
  // typing required, per household report 2026-09-05: picking a bucket
  // shouldn't first require searching/typing a merchant that's already
  // known), overridden by whatever's actually in the search box once the
  // household types something else.
  const applyAsMerchant = trimmedQuery || (merchant ?? "").trim();
  const dismiss = () =>
    startLink(async () => {
      setIsDismissed(true);
      await dismissRefundReview(transactionId, true);
      onOpenChange(false);
    });

  // Split state — one or more offsets already recorded.
  if (visibleOffsets.length > 0) {
    return (
      <div className="flex flex-col gap-1.5 text-xs">
        {visibleOffsets.map((o) => (
          <div key={o.id} className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <Scissors size={12} className="shrink-0" />
            <span className="truncate">
              {formatCents(o.amountCents)} → {o.debitDebtName ?? o.debitMerchant}
            </span>
            <button
              onClick={() => removeOffset(o.id)}
              disabled={linking}
              aria-label="Remove"
              title="Remove"
              className="shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <p className="text-neutral-500 dark:text-neutral-400">
          {formatCents(remainingCents)} still counts as income
        </p>
        {remainingCents > 0 &&
          (open ? (
            <>
              <button
                onClick={() => onOpenChange(false)}
                className="flex w-fit items-center gap-1 text-blue-900 dark:text-blue-300"
              >
                <X size={12} /> Cancel
              </button>
              <SplitPanel
                transactionId={transactionId}
                remainingCents={remainingCents}
                onAdded={() => onOpenChange(false)}
              />
            </>
          ) : (
            <button
              onClick={() => onOpenChange(true)}
              className="flex w-fit items-center gap-1 text-blue-900 dark:text-blue-300"
            >
              <Scissors size={12} /> Allocate To Another Payment
            </button>
          ))}
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 p-2">
        {allowSplit && (
          <div className="flex gap-1 text-[11px]">
            <button
              onClick={() => setMode("whole")}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${mode === "whole" ? "bg-blue-900 text-white dark:bg-blue-600" : "text-neutral-500"}`}
            >
              <Link2 size={11} /> Whole Refund
            </button>
            <button
              onClick={() => setMode("split")}
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 ${mode === "split" ? "bg-blue-900 text-white dark:bg-blue-600" : "text-neutral-500"}`}
            >
              <Scissors size={11} /> Allocate To Payments
            </button>
          </div>
        )}

        {allowSplit && mode === "split" ? (
          <SplitPanel
            transactionId={transactionId}
            remainingCents={remainingCents}
            onAdded={() => onOpenChange(false)}
            bordered={false}
          />
        ) : (
          <>
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Suggested</p>
                {suggestions.map((c, i) => (
                  <CandidateButton
                    key={c.id}
                    candidate={c}
                    disabled={linking}
                    isBestMatch={i === 0}
                    onPick={() => pick(c)}
                  />
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1">
              {/* Its own caption, not just a bare bordered box sitting right
                  under the Suggested list — otherwise it reads as one more
                  (blank-looking) candidate instead of an editable search box
                  (real household report, 2026-09-05: "what is the strange
                  text box... that just says 'Sam's Club'?"). */}
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Or Search A Different Purchase</p>
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
                />
                <input
                  value={query}
                  onChange={(e) => {
                    const value = e.target.value;
                    setQuery(value);
                    startSearch(async () =>
                      setResults(value.trim() ? await searchLinkableDebits(transactionId, value.trim()) : null),
                    );
                  }}
                  placeholder={`Search by merchant (e.g. ${merchant || "Verizon"})…`}
                  className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 py-1.5 pl-7 pr-7 text-xs focus:border-blue-900 focus:outline-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      setResults(null);
                    }}
                    aria-label="Clear Search"
                    title="Clear Search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              {searching && <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Searching…</p>}
              {results?.map((c) => (
                <CandidateButton key={c.id} candidate={c} disabled={linking} isBestMatch={false} onPick={() => pick(c)} />
              ))}
              {results !== null && results.length === 0 && !searching && (
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">No matches.</p>
              )}
            </div>

            {applyAsMerchant && (
              <div className="flex flex-col gap-1.5 border-t border-neutral-100 dark:border-neutral-800 pt-2">
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
                  Can&apos;t Find The Purchase? Mark It As A Refund Anyway
                </p>
                {buckets.length > 0 && (
                  <SelectField
                    value={merchantBucketId}
                    onChange={setMerchantBucketId}
                    small
                    options={[
                      ...buckets.map((b) => ({ value: b.id, label: `Reduce "${b.name}"` })),
                      { value: "", label: "Don't Reduce Any Bucket" },
                    ]}
                  />
                )}
                <button
                  onClick={() =>
                    startLink(async () => {
                      await linkReimbursementToMerchant(transactionId, applyAsMerchant, merchantBucketId || undefined);
                      setCurrentMerchant(applyAsMerchant);
                      showToast("Reimbursement Linked");
                      onOpenChange(false);
                    })
                  }
                  disabled={linking}
                  className="rounded-lg border border-blue-900/30 dark:border-blue-400/30 px-2 py-1.5 text-left text-xs font-medium text-blue-900 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40 disabled:opacity-50"
                >
                  Mark As Refund From &quot;{applyAsMerchant}&quot;
                </button>
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Stops counting as income.</p>
              </div>
            )}

            <div className="flex items-center justify-between border-t border-neutral-100 dark:border-neutral-800 pt-2">
              <p className="text-[11px] text-neutral-400 dark:text-neutral-500">Not a refund? Leave it as income.</p>
              <button
                onClick={dismiss}
                disabled={linking}
                className="flex w-fit items-center gap-1 text-[11px] text-neutral-400 hover:text-red-600 dark:text-neutral-500 dark:hover:text-red-400 disabled:opacity-50"
              >
                <Ban size={11} /> Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
