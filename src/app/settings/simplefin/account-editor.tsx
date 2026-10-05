"use client";

import { useActionState, useState, useTransition } from "react";
import { Pencil, Target, Wallet, X } from "lucide-react";
import {
  renameAccount,
  setAccountBudgetTracked,
  updateAccountApy,
  type RenameAccountState,
  type UpdateAccountApyState,
} from "./actions";
import {
  updateSyncedDebtTerms,
  setDebtIncludedInPayoffPlan,
  updateDebtKind,
  linkDebtAccount,
  type UpdateSyncedDebtTermsState,
} from "@/app/debts/actions";
import { InlineSaveButton } from "@/components/inline-save-button";
import { useActionToast } from "@/lib/use-action-toast";
import { showToast } from "@/lib/toast";
import { MoneyInput } from "@/components/money-input";
import { PercentInput } from "@/components/percent-input";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";
import { SelectField } from "@/components/select-field";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";
import { dayOfMonthUTC } from "@/lib/date";
import type { AccountType } from "@prisma/client";

const initialState: RenameAccountState = {};
const initialTermsState: UpdateSyncedDebtTermsState = {};
const initialApyState: UpdateAccountApyState = {};

async function toasted(run: () => Promise<unknown>, message = "Saved") {
  try {
    await run();
    showToast(message);
  } catch {
    showToast("Couldn’t Save", "error");
  }
}

// A linked debt's rate/payment/due-date, carried through unedited on every
// save (2026-08-16) — the form below only surfaces the three fields a
// household actually touches day to day; cadence/tolerance stay exactly as
// they were via hidden inputs instead of disappearing from the visible form
// AND getting silently reset (updateSyncedDebtTerms always writes whatever
// the form submits — cadence is required, category/bucket fall back to
// null/the household default when absent — so dropping them from the JSX
// without a hidden passthrough would blank out an existing choice on the
// next save). Category/bucket themselves got promoted to real editable
// fields here (2026-08-23, household report) — this was the *only* place a
// synced debt's DebtPayment lives (DebtPaymentRow hides its own inline form,
// bucket/category picker included, in favor of a link straight here — see
// its editInSettings comment), so a household genuinely had no way to
// recategorize or reassign one at all, anywhere in the app. The backend
// (updateSyncedDebtTerms) already accepted both fields; only the UI was
// missing them.
export type SyncedDebtSummary = {
  debtId: string;
  // CARD/LOAN — see DebtKind's doc comment in schema.prisma. Editable here
  // (updateDebtKind) same as a manual debt's; a synced CREDIT_CARD/LOAN
  // account is pre-set to match at track time (trackAccountAsDebt) but
  // stays correctable in case the linked account's own type is ambiguous.
  kind: "CARD" | "LOAN";
  aprBasisPoints: number;
  minPaymentCents: number;
  // See Debt.ignoreMinimumPayment in schema.prisma.
  ignoreMinimumPayment: boolean;
  cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "ANNUAL";
  toleranceCents: number | null;
  categoryId: string | null;
  bucketId: string | null;
  nextDueDate: string | null; // ISO date
  includeInPayoffPlan: boolean;
  // Every CREDIT_CARD/LOAN account, including one already linked to some
  // *other* debt (flagged via `linkedElsewhere`) — lets the household
  // manually re-point a synced debt at a different account. Self-service
  // fix for whenever a SimpleFIN reconnect reissues a new account id for
  // the same real-world account instead of cleanly replacing the old one
  // (household request, 2026-09-11; moved here from debts/debt-row.tsx
  // 2026-09-14 so account-identity edits live only in Settings, same as
  // every other debt edit; widened to allow stealing a `linkedElsewhere`
  // account 2026-09-14, same day, real report — see WORKING_ON.md).
  // linkDebtAccount auto-unlinks whichever debt loses the account, so this
  // only needs to confirm before it happens, not block it.
  linkableAccounts: { id: string; name: string; linkedElsewhere: boolean }[];
};

// The one place to edit a synced account's friendly name, whether it feeds
// the bucket transaction pipeline, and — for a CREDIT_CARD/LOAN account
// tracked as a Debt — its rate/payment/due date (2026-08-16 folded in
// SyncedDebtTermsForm's own separate pencil, which duplicated this one right
// next to it; see WORKING_ON.md). Was CHECKING/SAVINGS-only, briefly
// duplicated on /networth's CashAccountRow too (removed the same day: two
// independently-editable name fields for the same account drifted out of
// sync, and a linked Asset's own `name` field had the identical problem —
// see asset-row.tsx's displayName comment). Every place a debt/account/asset
// name renders elsewhere in the app prefers this over the raw synced name
// once set — see WORKING_ON.md.
//
// Renders the account's name itself (not just the pencil) so the pencil
// click can swap that name in place for a rename input, instead of the
// title staying put with a second, pre-filled "rename" box appearing below
// it (2026-08-18 — the old layout showed the same name twice at once, and a
// nested `inline-flex` (nowrap) wrapper around the toggle + expand panel
// fought the `w-full` panel trying to wrap onto its own line, which is what
// made the pencil/badge icons downstream in page.tsx visually jump around
// when editing opened).
//
// The whole thing (name input, terms fields, toggles) is one `<form>` with
// one Save button — originally the name input had its own little checkmark
// submit button beside it, redundant with the "real" Save button below for
// the terms fields (two different-looking save affordances on one small
// card reads as inconsistent — feedback after the first pass). Submitting
// invokes both `formAction` (rename) and, when a debt is linked,
// `termsFormAction` (terms) against the same FormData — each one only reads
// the field names its own schema cares about and ignores the rest, so one
// submit cleanly drives two independent server actions/mutations without
// them needing to be merged into a single action function. The form itself
// is `display: contents` (Tailwind's `contents` class) so it doesn't
// introduce a box of its own — its children still land as direct items of
// the page.tsx `flex flex-wrap` row they're placed in, same reasoning as
// the Fragment this replaced: the toggle button and (when collapsed) the
// name never move, only the `w-full` panel below wraps onto its own line.
export function AccountEditor({
  accountId,
  displayName,
  budgetTracked,
  accountType,
  apyBasisPoints,
  debt,
  buckets = [],
  categories = [],
  badges,
}: {
  accountId: string;
  displayName: string;
  budgetTracked: boolean;
  // Gates the APY field below — optional for every non-debt account type
  // (CHECKING/SAVINGS/INVESTMENT/OTHER); a CREDIT_CARD/LOAN account carries
  // its rate via the linked Debt's APR instead (see the `debt` block below),
  // so the two fields never both show for the same account.
  accountType: AccountType;
  apyBasisPoints?: number | null;
  debt?: SyncedDebtSummary | null;
  buckets?: { id: string; name: string }[];
  categories?: CategoryOption[];
  // Classification icons (asset/goal/debt/transactions) — rendered by the
  // caller (page.tsx) since it's the one with the account-type/linked-record
  // context to compute them, but placed here (not as JSX siblings after
  // <AccountEditor/>) so they land right after the pencil/X button in DOM
  // order, ahead of the `w-full` edit box. Sibling placement meant the edit
  // box's forced line-wrap pushed them onto their own row below the whole
  // expanded panel while editing — inconsistent with the collapsed view,
  // where they sit right next to the name (2026-08-18, real screenshot).
  badges?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const renameWithId = renameAccount.bind(null, accountId);
  const [state, formAction, pending] = useActionState(renameWithId, initialState);
  const [budgetPending, startBudgetTransition] = useTransition();
  const [payoffPending, startPayoffTransition] = useTransition();
  const [kindPending, startKindTransition] = useTransition();
  // Bound even when there's no debt (rules of hooks) — harmless, since the
  // form below that would actually invoke it only renders when `debt` is set.
  const updateTermsWithId = updateSyncedDebtTerms.bind(null, debt?.debtId ?? "");
  const [termsState, termsFormAction, termsPending] = useActionState(updateTermsWithId, initialTermsState);
  const showApy = accountType !== "CREDIT_CARD" && accountType !== "LOAN";
  const updateApyWithId = updateAccountApy.bind(null, accountId);
  const [apyState, apyFormAction, apyPending] = useActionState(updateApyWithId, initialApyState);
  const { justSaved } = useActionToast(pending, state, { success: "Account Saved" });
  const [dueDay, setDueDay] = useState(debt?.nextDueDate ? String(dayOfMonthUTC(debt.nextDueDate)) : "");
  const [ignoreMinimum, setIgnoreMinimum] = useState(debt?.ignoreMinimumPayment ?? false);
  const [bucketId, setBucketId] = useState(debt?.bucketId ?? "");
  const [linkedAccountId, setLinkedAccountId] = useState(accountId);
  const [linkPending, startLinkTransition] = useTransition();

  return (
    <form
      className="contents"
      action={(formData) => {
        formAction(formData);
        if (debt) termsFormAction(formData);
        if (showApy) apyFormAction(formData);
        setEditing(false);
      }}
    >
      {editing ? (
        <input
          name="name"
          defaultValue={displayName}
          required
          autoFocus
          className="min-w-0 flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-1.5 py-0.5 text-sm font-medium focus:border-blue-900 focus:outline-none"
        />
      ) : (
        <span className="truncate">{displayName}</span>
      )}
      {badges}
      {/* Right-aligned (2026-08-26 — was right after the name; moved past
          the type badges so every row on this page reads name/icons/label
          left, Edit (and Hide, when the caller renders one right after this
          component) right). */}
      <button
        type="button"
        onClick={() => setEditing((v) => !v)}
        aria-label={editing ? "Cancel Editing Account" : "Edit Account"}
        title={editing ? "Cancel" : "Edit"}
        className="ml-auto shrink-0 text-neutral-400 dark:text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        {editing ? <X size={12} /> : <Pencil size={12} />}
      </button>
      {editing && (
        <div className="mt-3 flex w-full flex-col gap-3 rounded-lg border border-blue-100 dark:border-neutral-800 p-3">
          {state.error && <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p>}
          {/* APY + the Use-for-Transactions toggle share one line (household
              request 2026-09-08); the toggle is an icon button mirroring the
              Wallet classification badge up by the account name. For a debt
              account this row doesn't render — its Wallet toggle lives in the
              debt panel's own first row instead. */}
          {(showApy || !debt) && (
            <div className="flex items-end gap-3">
              {showApy && (
                <label className="flex w-28 shrink-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  APY
                  <PercentInput
                    name="apy"
                    defaultPercent={apyBasisPoints != null ? apyBasisPoints / 100 : undefined}
                    placeholder="Optional"
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                  />
                </label>
              )}
              {!debt && (
                <button
                  type="button"
                  disabled={budgetPending}
                  aria-pressed={budgetTracked}
                  onClick={() => startBudgetTransition(() => toasted(() => setAccountBudgetTracked(accountId, !budgetTracked), budgetTracked ? "No Longer Used for Transactions" : "Now Used for Transactions"))}
                  aria-label="Use for Transactions"
                  title="Use for Transactions"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
                    budgetTracked
                      ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : "border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
                  }`}
                >
                  <Wallet size={14} />
                </button>
              )}
            </div>
          )}
          {apyState.error && <p className="text-xs text-red-600 dark:text-red-400">{apyState.error}</p>}
          {debt && (
            <div className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 p-2">
              <input type="hidden" name="cadence" value={debt.cadence} />
              <input type="hidden" name="tolerance" value={debt.toleranceCents !== null ? String(debt.toleranceCents / 100) : ""} />
              {/* Fixed field order (household layout request, 2026-09-08):
                  Card/Loan + membership toggles / APR·Minimum·Due Date /
                  no-minimum opt-out / Bucket·Category. The two membership
                  toggles are icon-only here — each mirrors the matching
                  classification badge up by the account name (Wallet = used
                  for transactions, Target = in the payoff plan), so flipping
                  one makes that badge appear or vanish. They fire their own
                  server actions immediately (not part of the form submit),
                  same as before. */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex h-7 w-fit items-center gap-1 rounded-lg border border-neutral-300 dark:border-neutral-700 p-0.5 text-xs">
                  {(["CARD", "LOAN"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      disabled={kindPending}
                      onClick={() => startKindTransition(() => toasted(() => updateDebtKind(debt.debtId, k), "Type Saved"))}
                      className={`flex h-full items-center rounded-md px-2 font-medium disabled:opacity-50 ${
                        debt.kind === k ? "bg-blue-900 dark:bg-blue-700 text-white" : "text-neutral-500 dark:text-neutral-400"
                      }`}
                    >
                      {k === "CARD" ? "Card" : "Loan"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={budgetPending}
                  aria-pressed={budgetTracked}
                  onClick={() => startBudgetTransition(() => toasted(() => setAccountBudgetTracked(accountId, !budgetTracked), budgetTracked ? "No Longer Used for Transactions" : "Now Used for Transactions"))}
                  aria-label="Use for Transactions"
                  title="Use for Transactions"
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
                    budgetTracked
                      ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : "border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
                  }`}
                >
                  <Wallet size={13} />
                </button>
                <button
                  type="button"
                  disabled={payoffPending}
                  aria-pressed={debt.includeInPayoffPlan}
                  onClick={() =>
                    startPayoffTransition(() => toasted(() => setDebtIncludedInPayoffPlan(debt.debtId, !debt.includeInPayoffPlan), debt.includeInPayoffPlan ? "Removed from Payoff Plan" : "Added to Payoff Plan"))
                  }
                  aria-label="Include in Payoff Plan"
                  title="Payoff Plan"
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
                    debt.includeInPayoffPlan
                      ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-400"
                      : "border-neutral-300 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
                  }`}
                >
                  <Target size={13} />
                </button>
              </div>
              {/* Self-service fix for a SimpleFIN reconnect that reissues a
                  new account id for the same real-world account instead of
                  cleanly replacing the old one. Always visible (not just
                  when there's a real second candidate) so the household can
                  see and confirm the option exists — the Save button stays
                  disabled until a different account is actually picked.
                  A `linkedElsewhere` option is confirmed before saving,
                  since picking it un-links whatever other debt currently
                  claims that account (linkDebtAccount does this
                  automatically — see its own comment). Fires its own action
                  immediately (like the Card/Loan/Wallet/Target controls
                  above), not folded into the main Save button, since it's a
                  distinct re-association rather than a terms edit. */}
              {debt.linkableAccounts.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Linked Account
                  <div className="mt-1 flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <SelectField
                        name="linkedAccountId"
                        value={linkedAccountId}
                        onChange={setLinkedAccountId}
                        options={debt.linkableAccounts.map((a) => ({
                          value: a.id,
                          label: a.linkedElsewhere ? `${a.name} — Linked to Another Debt` : a.name,
                        }))}
                        small
                      />
                    </span>
                    <button
                      type="button"
                      disabled={linkPending || linkedAccountId === accountId}
                      onClick={() => {
                        const target = debt.linkableAccounts.find((a) => a.id === linkedAccountId);
                        if (
                          target?.linkedElsewhere &&
                          !confirm(
                            `"${target.name}" is already linked to another debt. Linking it here will unlink it from there instead (that debt becomes manual, nothing is deleted). Continue?`,
                          )
                        )
                          return;
                        startLinkTransition(() => toasted(() => linkDebtAccount(debt.debtId, linkedAccountId), "Account Linked"));
                      }}
                      className="shrink-0 rounded-lg bg-blue-900 dark:bg-blue-700 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {linkPending ? "…" : "Save"}
                    </button>
                  </div>
                </label>
              )}
              <div className="grid grid-cols-3 gap-2">
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  APR
                  <PercentInput
                    name="apr"
                    defaultPercent={debt.aprBasisPoints / 100}
                    placeholder="APR %"
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Minimum
                  <MoneyInput
                    name="minPayment"
                    defaultCents={debt.minPaymentCents}
                    placeholder="Min $"
                    disabled={ignoreMinimum}
                    className="mt-1 w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none disabled:opacity-50"
                  />
                </label>
                <DayOfMonthPicker name="dueDay" value={dueDay} onChange={setDueDay} label="Due Date" small />
              </div>
              <label className="inline-flex w-fit items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <input
                  type="checkbox"
                  name="ignoreMinimum"
                  checked={ignoreMinimum}
                  onChange={(e) => setIgnoreMinimum(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-neutral-300 dark:border-neutral-700"
                />
                No real minimum — don&apos;t track one
              </label>
              <div className={buckets.length > 0 ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2"}>
                {buckets.length > 0 && (
                  <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                    Bucket
                    <SelectField
                      name="bucketId"
                      value={bucketId}
                      onChange={setBucketId}
                      options={[{ value: "", label: "None" }, ...buckets.map((b) => ({ value: b.id, label: b.name }))]}
                      className="mt-1"
                      small
                    />
                  </label>
                )}
                <label className="flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
                  Category
                  <div className="mt-1">
                    <CategoryPicker
                      key={bucketId}
                      categories={categories.filter((c) => c.bucketId === bucketId)}
                      defaultCategoryId={debt.categoryId}
                      bucketId={bucketId || null}
                      name="categoryId"
                      small
                    />
                  </div>
                </label>
              </div>
              {termsState.error && <p className="text-xs text-red-600 dark:text-red-400">{termsState.error}</p>}
            </div>
          )}
          {/* No "remove this account" action here, deliberately — a synced
              account only ever goes hidden by actually being gone from
              SimpleFIN (see hideAccountsWithLinkedDebts,
              src/lib/simplefin-sync.ts). The nearest a household gets by
              hand is hideDebt on its linked Debt, when paid off (the
              eye-off badge elsewhere on this row) — which never touches
              this Account's own hiddenAt. */}
          <InlineSaveButton pending={pending || termsPending || apyPending} justSaved={justSaved} />
        </div>
      )}
    </form>
  );
}
