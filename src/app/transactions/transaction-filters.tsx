"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Filter, FilterX, Search, X } from "lucide-react";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";

function dollarsToCents(v: string): number | undefined {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

type AccountOption = { id: string; name: string; orgName: string | null; displayName: string | null; budgetTracked: boolean };

function accountLabel(a: AccountOption): string {
  return a.displayName ?? (a.orgName ? `${a.orgName} ${a.name}` : a.name);
}

// Ungrouped options render first (SelectField's groupOptions keeps
// first-appearance order, both of groups and of items within one) — these
// six are settled/confirmed states or broad either-or filters, nothing left
// to decide. The five below, all sharing the "Needs Review" group, are the
// opposite: every one of them is a household member's decision waiting to
// happen (real request, 2026-09-06: "move all the 'Possible' entries that
// need assistance to the bottom... give them a sub header") — grouped by
// what they ask of a household, not by their exact wording, so
// "Uncategorized" and "P2P Review" belong here too even without literally
// saying "Possible".
const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "bucket", label: "Bucketed" },
  { value: "debt", label: "Debt Payment" },
  { value: "income", label: "Income" },
  // "Transfer" means only money moving between the household's own
  // accounts (checking<->savings) — never a debt/P2P/BNPL payment
  // (2026-08-25 household rule). "unresolvedDebt"/"unresolvedBnpl" below are
  // the two other isTransfer:true/debtId:null cases that used to get lumped
  // in here under the same misleading word — see statusWhere, transactions/page.tsx.
  { value: "transfer", label: "Transfer" },
  // Kept as "Money Out"/"Money In", not renamed for technical precision — a
  // stricter "Not Income" would be more accurate (see statusWhere's own
  // comment: this can include an unconfirmed P2P credit or a refund
  // candidate, not just literal outflows) — but the two need distinct labels
  // within this one dropdown, and "Money Out"/"Money In" is what a household
  // actually means by each. The buckets/income pills that deep-link straight
  // to these two filters now just say "Transactions" instead of duplicating
  // either label (2026-09-23) — no need to keep the two in sync anymore.
  { value: "notIncome", label: "Money Out" },
  { value: "moneyIn", label: "Money In (Incl. Transfers)" },
  // Not a decision queue like the "Needs Review" group below — SimpleFIN's
  // "not settled yet" flag, useful for a household checking whether
  // something's cleared, not something anyone needs to act on.
  { value: "pending", label: "Pending" },

  // --- Needs Review — every one of these is an unresolved decision, never
  // a confirmed state (see the module comment above) ---
  { value: "uncategorized", label: "Uncategorized", group: "Needs Review" },
  { value: "unresolvedDebt", label: "Possible Debt Payment", group: "Needs Review" },
  { value: "unresolvedBnpl", label: "Possible BNPL Payment", group: "Needs Review" },
  { value: "unlabeledP2P", label: "P2P Review", group: "Needs Review" },
  // Same queue the dashboard's "Refund Matching" card links to
  // (?status=unmatchedRefund, src/lib/refund-match.ts's getUnmatchedRefunds)
  // — a refund credit matching 2+ past purchases, needing a human pick.
  // Wasn't reachable from this dropdown before (only via that card's deep
  // link) — a household searching for it manually had no way to land here
  // (real report, 2026-09-05: "The 'Type' for this search should actually
  // be 'Refunds'"). "Possible" (not bare "Refunds"), same as
  // unresolvedDebt/unresolvedBnpl above — a *confirmed* refund isn't in this
  // queue at all (reimbursesTransactionId/Merchant gets set, dropping it out
  // of getUnmatchedRefunds) and isn't income either (isIncome:false, nets
  // against its bucket instead — verified against live data, 2026-09-06);
  // this option only ever surfaces the still-undecided ones.
  { value: "unmatchedRefund", label: "Possible Refunds", group: "Needs Review" },
];

// Plain GET-query filters (account/date range/amount range/status/search)
// pushed via the router rather than a native form submit — SelectField isn't
// a native <select>, so it needs an onChange handler wired to the URL rather
// than relying on form submission. Resets `page` to 1 on every apply, since
// a stale page number from the prior filter set could point past the end of
// the new result set.
export function TransactionFilters({
  accounts,
  current,
}: {
  accounts: AccountOption[];
  current: {
    account: string;
    from: string;
    to: string;
    status: string;
    q: string;
    budgetOnly: boolean;
    amountMin: string;
    amountMax: string;
  };
}) {
  const router = useRouter();
  const [account, setAccount] = useState(current.account);
  const [from, setFrom] = useState(current.from);
  const [to, setTo] = useState(current.to);
  const [status, setStatus] = useState(current.status);
  const [q, setQ] = useState(current.q);
  const [budgetOnly, setBudgetOnly] = useState(current.budgetOnly);
  const [amountMin, setAmountMin] = useState(current.amountMin);
  const [amountMax, setAmountMax] = useState(current.amountMax);
  // MoneyInput keeps its own internal digit state, so clearing it needs a
  // remount (same pattern as add-asset-form) — bump this on toggle-clear.
  const [amountKey, setAmountKey] = useState(0);
  // Mobile/tablet only (desktop always shows the section — see its lg:flex
  // override below, 2026-09-23): collapsed by default, only search and type
  // stay visible, unless a filter from this "more filters" section
  // (account/date/amount/budget scope) is already active from the URL (a
  // direct link, a page reload), in which case starting collapsed would hide
  // an applied filter (though the Filter toggle icon does flag it). Type has
  // its own always-visible slot next to the search bar now, so it no longer
  // factors into this check.
  const [expanded, setExpanded] = useState(
    Boolean(current.account || current.from || current.to || current.amountMin || current.amountMax) ||
      !current.budgetOnly,
  );

  function buildQuery(qValue: string): URLSearchParams {
    const qs = new URLSearchParams();
    if (account) qs.set("account", account);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (status && status !== "all") qs.set("status", status);
    if (qValue) qs.set("q", qValue);
    if (!budgetOnly) qs.set("budgetOnly", "0");
    if (amountMin) qs.set("amountMin", amountMin);
    if (amountMax) qs.set("amountMax", amountMax);
    return qs;
  }

  function apply(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/transactions?${buildQuery(q).toString()}`);
  }

  // Live-filters as the search box is typed into — everything else (type,
  // account, dates, amounts, budget scope) still only applies via the blue
  // Search button, per feedback that only the text box should be live. Debounced (350ms of no typing) and via router.replace (not push),
  // so a fast typist doesn't fire a query per keystroke or bury the actual
  // "before I searched" page in history under one entry per character.
  // buildQuery is recreated every render, so this always reads the latest
  // account/status/etc. even though only `q` is in the dependency array —
  // deliberate: re-running for every OTHER filter's change too would make
  // those live as well, which is exactly what wasn't wanted here.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      router.replace(`/transactions?${buildQuery(q).toString()}`);
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // Just resets the text box — the debounce effect above then live-applies
  // the clear the same way any other edit does, after its normal delay.
  function clearSearchText() {
    setQ("");
  }

  // Every "more filters" field that isn't at its default — the section is
  // considered engaged whenever any of these is set (or the panel is open).
  const hasMoreFilters = Boolean(account || from || to || amountMin || amountMax || !budgetOnly);
  const filtersEngaged = expanded || hasMoreFilters;

  // Count of engaged predicates across the whole form (search + type + the
  // "more filters" section) — drives the "N Filters Active" badge.
  const activeFilterCount = [
    Boolean(q),
    status !== "all",
    Boolean(account),
    Boolean(from),
    Boolean(to),
    Boolean(amountMin),
    Boolean(amountMax),
    !budgetOnly,
  ].filter(Boolean).length;

  // The Filter icon now only expands/collapses the "more filters" section.
  // Clearing is the explicit, always-visible "Clear Filters" control below.
  function toggleFilters() {
    setExpanded((v) => !v);
  }

  // Resets every filter (search, type, and the "more filters" section) back to
  // its default and drops every query param.
  function clearAll() {
    setQ("");
    setStatus("all");
    setAccount("");
    setFrom("");
    setTo("");
    setBudgetOnly(true);
    setAmountMin("");
    setAmountMax("");
    setAmountKey((k) => k + 1);
    setExpanded(false);
    router.push("/transactions");
  }

  // Only offer a non-tracked account in the dropdown once "Budget accounts
  // only" is off — otherwise picking one from the list would silently
  // conflict with the budgetTrackedWhere() clause the page applies (see
  // src/lib/buckets.ts), returning zero results with no visible reason why.
  const visibleAccounts = budgetOnly ? accounts.filter((a) => a.budgetTracked) : accounts;

  return (
    <form onSubmit={apply} className="flex flex-col gap-2 rounded-xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="relative">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search merchant, tag, category, bucket…"
          className="min-w-0 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 pr-9 text-sm focus:border-blue-900 focus:outline-none"
        />
        {q && (
          <button
            type="button"
            onClick={clearSearchText}
            aria-label="Clear Search"
            title="Clear Search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Type promoted out of "more filters" — always visible right under
          the search bar, submitted the same way (this whole block is still
          inside the <form>), not gated behind the collapse toggle. */}
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-neutral-600 dark:text-neutral-400">Type</span>
        <SelectField
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS}
          searchable={false}
          small
          className="min-w-0 flex-1"
        />
        <button
          type="submit"
          aria-label="Search"
          title="Search"
          className="shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-white"
        >
          <Search size={16} />
        </button>
        {/* Desktop always shows the "more filters" section below (see its
            lg:flex override) — there's nothing left to toggle there, so the
            button itself is mobile/tablet-only. */}
        <button
          type="button"
          onClick={toggleFilters}
          aria-label={expanded ? "Hide Filters" : "Show Filters"}
          title={expanded ? "Hide Filters" : "Filters"}
          className={`shrink-0 rounded-lg border px-3 py-1.5 lg:hidden ${
            filtersEngaged
              ? "border-blue-900 dark:border-blue-700 text-blue-900 dark:text-blue-300"
              : "border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          {expanded ? <FilterX size={16} /> : <Filter size={16} />}
        </button>
      </div>

      {activeFilterCount > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-900 dark:bg-blue-950 dark:text-blue-300">
            {activeFilterCount} Filter{activeFilterCount === 1 ? "" : "s"} Active
          </span>
          <button
            type="button"
            onClick={clearAll}
            className="font-medium text-blue-900 hover:underline dark:text-blue-300"
          >
            Clear Filters
          </button>
        </div>
      )}

      {/* Mobile/tablet: gated behind the Filter toggle, collapsed by
          default. Desktop: always visible (lg:flex overrides the mobile
          "hidden" regardless of `expanded`) — there's room for it, and no
          toggle button is rendered there to turn it off. */}
      <div className={`flex-col gap-2 lg:flex ${expanded ? "flex" : "hidden"}`}>
        <SelectField
          value={account}
          onChange={setAccount}
          options={[
            { value: "", label: "All Accounts" },
            ...visibleAccounts.map((a) => ({ value: a.id, label: accountLabel(a) })),
          ]}
          small
        />
        <label className="flex w-fit items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <span
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              budgetOnly ? "bg-blue-900 dark:bg-blue-700" : "bg-neutral-300 dark:bg-neutral-700"
            }`}
          >
            <input
              type="checkbox"
              checked={budgetOnly}
              onChange={() => setBudgetOnly((v) => !v)}
              className="sr-only"
            />
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                budgetOnly ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </span>
          Budget Accounts Only
        </label>
        <div className="flex gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs focus:border-blue-900 focus:outline-none"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs focus:border-blue-900 focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          {[
            { initial: current.amountMin, set: setAmountMin, placeholder: "Min $", label: "Minimum Amount" },
            { initial: current.amountMax, set: setAmountMax, placeholder: "Max $", label: "Maximum Amount" },
          ].map((f) => (
            <MoneyInput
              key={`${f.label}-${amountKey}`}
              defaultCents={dollarsToCents(f.initial)}
              onValueChange={f.set}
              placeholder={f.placeholder}
              aria-label={f.label}
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-xs tabular-nums focus:border-blue-900 focus:outline-none"
            />
          ))}
        </div>
      </div>
    </form>
  );
}
