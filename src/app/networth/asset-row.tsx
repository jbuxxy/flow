"use client";

import { useActionState, useState, useTransition } from "react";
import NextLink from "next/link";
import {
  AlertTriangle,
  Bitcoin,
  Briefcase,
  Car,
  Caravan,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Home,
  Landmark,
  Link2,
  Package,
  PiggyBank,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { isAssetStale } from "@/lib/asset-staleness";
import { useKebabEditRow } from "@/lib/use-kebab-edit-row";
import {
  deleteAsset,
  linkAssetAccount,
  linkAssetDebt,
  createLinkedDebt,
  updateAssetValue,
  updateAssetEstimateDetails,
  rerunAssetEstimate,
  confirmAssetValue,
  type UpdateAssetValueState,
  type AssetFormState,
  type CreateLinkedDebtState,
} from "./actions";
import { CryptoIcon } from "@/components/crypto-icon";
import { RowActions, type RowAction } from "@/components/row-actions";
import { PercentInput } from "@/components/percent-input";
import { useActionToast } from "@/lib/use-action-toast";
import type { Asset } from "@prisma/client";
import type { VehicleEstimateDetails, HomeEstimateDetails } from "@/lib/ai";
import type { CryptoEstimateDetails } from "@/lib/crypto-lookup";
import { VehicleEstimateFields } from "./vehicle-estimate-fields";
import { CryptoEstimateFields } from "./crypto-estimate-fields";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";

const TYPE_LABEL: Record<Asset["assetType"], string> = {
  RETIREMENT_401K: "401(k)",
  RETIREMENT_IRA: "IRA",
  RETIREMENT_PENSION: "Pension",
  HOME_EQUITY: "Home",
  VEHICLE_EQUITY: "Vehicle",
  INVESTMENT: "Investment",
  CRYPTO: "Crypto",
  OTHER: "Other",
};

const TYPE_ICON: Record<Asset["assetType"], LucideIcon> = {
  RETIREMENT_401K: Briefcase,
  RETIREMENT_IRA: PiggyBank,
  RETIREMENT_PENSION: Landmark,
  HOME_EQUITY: Home,
  VEHICLE_EQUITY: Car,
  INVESTMENT: TrendingUp,
  CRYPTO: Bitcoin,
  OTHER: Package,
};

const initialValueState: UpdateAssetValueState = {};
const initialEstimateState: AssetFormState = {};
const initialLoanState: CreateLinkedDebtState = {};

function EstimateDetailsFields({ asset }: { asset: Asset }) {
  if (asset.assetType === "VEHICLE_EQUITY") {
    const d = (asset.estimateDetails as VehicleEstimateDetails | null) ?? null;
    const structured = d && "year" in d ? d : null;
    return (
      <VehicleEstimateFields
        defaultYear={structured?.year}
        defaultMake={structured?.make}
        defaultModel={structured?.model}
        defaultTrim={structured?.trim}
        defaultMileage={structured?.mileage}
        defaultCondition={d?.condition}
        defaultDescription={d && "description" in d ? d.description : undefined}
      />
    );
  }

  if (asset.assetType === "CRYPTO") {
    const d = (asset.estimateDetails as CryptoEstimateDetails | null) ?? null;
    return (
      <CryptoEstimateFields defaultCoinId={d?.coinId} defaultSymbol={d?.symbol} defaultQuantity={d?.quantity} />
    );
  }

  const d = (asset.estimateDetails as HomeEstimateDetails | null) ?? null;
  return (
    <>
      <input
        name="address"
        placeholder="Street address, city, state"
        defaultValue={d?.address ?? ""}
        className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
      />
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            name="bedrooms"
            placeholder="e.g. 3"
            defaultValue={d?.bedrooms ?? ""}
            inputMode="numeric"
            className="w-full pr-11 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-neutral-500">
            Beds
          </span>
        </div>
        <div className="relative flex-1">
          <input
            name="bathrooms"
            placeholder="e.g. 2"
            defaultValue={d?.bathrooms ?? ""}
            inputMode="decimal"
            className="w-full pr-12 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-neutral-500">
            Baths
          </span>
        </div>
        <div className="relative flex-1">
          <input
            name="sqft"
            placeholder="e.g. 1800"
            defaultValue={d?.sqft ?? ""}
            inputMode="numeric"
            className="w-full pr-10 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-neutral-500">
            Sqft
          </span>
        </div>
      </div>
    </>
  );
}

export function AssetRow({
  asset,
  accounts,
  debts,
  cryptoSymbol,
}: {
  asset: Asset & {
    debt:
      | {
          id: string;
          name: string;
          balanceCents: number;
          account: { displayName: string | null; orgName: string | null } | null;
        }
      | null;
  };
  accounts: { id: string; name: string; displayName: string | null; orgName: string | null }[];
  debts: { id: string; name: string; balanceCents: number }[];
  // Ticker (from estimateDetails) for a CRYPTO asset's coin, used to look up
  // its brand icon. Undefined for every other asset type — CryptoIcon then
  // falls back to a generic glyph.
  cryptoSymbol?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  // Drives the "Paid off" checkbox and whether the linked-debt picker shows
  // — kept as its own optimistic local state rather than derived from
  // asset.debt on every render. Deriving it from props caused a real bug:
  // clicking "paid off" while a debt was linked fires an async
  // linkAssetDebt(id, "") transition, but the prop (asset.debt) doesn't
  // update until the server round-trips and revalidates, so a
  // prop-derived `checked` snapped back to unchecked immediately after the
  // click (Playwright caught this as "did not change its state" — the
  // native click toggled the DOM instantly, then the controlled re-render
  // fought it back). Set directly by each action instead, so the checkbox
  // reflects intent immediately.
  const [paidOff, setPaidOff] = useState(asset.debt === null);
  const [addingLoan, setAddingLoan] = useState(false);
  const [deletePending, startDeleteTransition] = useTransition();
  const [linkPending, startLinkTransition] = useTransition();
  const [debtLinkPending, startDebtLinkTransition] = useTransition();
  const [rerunPending, startRerunTransition] = useTransition();
  const [confirmPending, startConfirmTransition] = useTransition();
  const updateValueWithId = updateAssetValue.bind(null, asset.id);
  const [state, formAction, pending] = useActionState(updateValueWithId, initialValueState);
  const updateEstimateWithId = updateAssetEstimateDetails.bind(null, asset.id);
  const [estimateState, estimateFormAction, estimatePending] = useActionState(
    updateEstimateWithId,
    initialEstimateState,
  );
  const createLoanWithId = createLinkedDebt.bind(null, asset.id);
  const [loanState, loanFormAction, loanPending] = useActionState(createLoanWithId, initialLoanState);
  useActionToast(loanPending, loanState, {
    success: "Loan Linked",
    onSuccess: () => {
      setAddingLoan(false);
      setPaidOff(false);
    },
  });
  const linked = asset.source === "SIMPLEFIN";
  const aiEstimated = asset.source === "AI_ESTIMATE";
  const livePriced = asset.source === "LIVE_PRICE";
  // See isAssetStale in lib/networth.ts — 3+ months since asOfDate last
  // moved. Only a MANUAL asset gets the one-click "still accurate" Confirm
  // action; a stale SIMPLEFIN/AI_ESTIMATE/LIVE_PRICE asset means its own
  // automatic refresh is failing, so the fix there is re-running it (the
  // Sparkles button), not attesting to a number nobody actually checked.
  const stale = isAssetStale(asset.asOfDate);
  const canEstimate =
    asset.assetType === "VEHICLE_EQUITY" || asset.assetType === "HOME_EQUITY" || asset.assetType === "CRYPTO";
  // "Appreciable" assets (home/vehicle) can carry the mortgage/auto loan
  // that secures them (see Asset.debtId) — when linked, the condensed row
  // headline switches from full value to equity, with a click-to-expand
  // breakdown. Net worth's total already subtracts every debt regardless of
  // this link; it only changes what this one row displays.
  const isAppreciable = asset.assetType === "HOME_EQUITY" || asset.assetType === "VEHICLE_EQUITY";
  const hasLinkedDebt = isAppreciable && asset.debt !== null;
  const equityCents = hasLinkedDebt ? asset.valueCents - asset.debt!.balanceCents : asset.valueCents;
  const linkedAccount = asset.accountId ? accounts.find((a) => a.id === asset.accountId) : undefined;
  // A linked (SIMPLEFIN-sourced) asset reads its headline name live from the
  // account's own friendly name (renamed centrally on /settings/accounts,
  // via AccountEditor) rather than the Asset's own `name` field — the
  // two used to drift independently (a separate rename form right here),
  // which meant renaming an account in Settings silently stopped applying
  // once a household had ever touched this row's own name field. A
  // debt-linked HOME_EQUITY/VEHICLE_EQUITY asset (mortgage/auto loan — see
  // Asset.debtId) gets the same treatment: the loan's friendly name is the
  // headline, not a second independently-editable Asset.name that could
  // drift from it. Prefer the loan's *synced account* displayName (renamed
  // via AccountEditor — "Van", "Home") over the raw Debt.name, which for a
  // SimpleFIN loan is an ugly "2026 Voyager Loan *2468 (2468)" (household
  // report, 2026-09-08). Only falls back to asset.name when there's no such
  // source to defer to at all.
  const displayName = linked
    ? (linkedAccount?.displayName ?? linkedAccount?.name ?? asset.name)
    : hasLinkedDebt
      ? (asset.debt!.account?.displayName ?? asset.debt!.name)
      : asset.name;
  // The middle "institution" line (household request, 2026-09-08): the lender
  // / bank. For a synced asset that's its own account's org; for a debt-
  // backed home/vehicle it's the *loan's* synced account's org (the mortgage
  // lender — "Summit Home Loans", "Canyon CU"), never the loan
  // name itself (already the headline above). Null for a plain manual asset,
  // crypto, or a manually-entered loan with no synced account — those
  // collapse to the 2-line layout (name/value, then the "As Of …" line
  // carrying the kebab).
  const institution = linkedAccount?.orgName ?? asset.debt?.account?.orgName ?? null;
  // Vehicle estimate details are a discriminated union (see
  // VehicleEstimateDetails) — year/make/model for a normal car/truck NHTSA
  // can look up, or a freeform "description" for anything it can't
  // (trailers, most of all — see vehicle-lookup.ts). Same signal
  // EstimateDetailsFields already uses to pick which form to show; reused
  // here to pick a more specific icon than a generic Car for that freeform
  // case.
  const vehicleDetails =
    asset.assetType === "VEHICLE_EQUITY" ? (asset.estimateDetails as VehicleEstimateDetails | null) : null;
  const isFreeformVehicle = Boolean(vehicleDetails && "description" in vehicleDetails);
  const TypeIcon = isFreeformVehicle ? Caravan : TYPE_ICON[asset.assetType];
  const typeLabel = isFreeformVehicle ? "Trailer / Other" : TYPE_LABEL[asset.assetType];
  const typeTooltip = linkedAccount
    ? (linkedAccount.orgName ?? linkedAccount.displayName ?? linkedAccount.name)
    : typeLabel;
  const canLinkAccount =
    accounts.length > 0 &&
    asset.assetType !== "HOME_EQUITY" &&
    asset.assetType !== "VEHICLE_EQUITY" &&
    asset.assetType !== "CRYPTO";
  // Linked assets no longer have their own name field to edit here (see the
  // displayName comment above) — the pencil still opens edit mode for them
  // solely to reach the linked-account picker below. Same for a debt-linked
  // appreciable asset: name isn't editable here, but the pencil still opens
  // edit mode to reach the linked-debt picker and (for CRYPTO/HOME/VEHICLE)
  // the AI estimate details.
  const editLabel = linked
    ? "Edit Linked Account"
    : hasLinkedDebt
      ? "Edit Linked Loan and Value"
      : `Edit Name and Value${isAppreciable ? " and Linked Debt" : canLinkAccount ? " and Linked Account" : ""}`;
  const { editing, setEditing, setActionsOpen, editAction, rowActionsProps } = useKebabEditRow(editLabel);
  const showDebtLinkIcon = isAppreciable && (hasLinkedDebt || paidOff) && !editing;
  const showAccountLinkIcon = canLinkAccount && !editing;

  // The value/name/estimate `<form>` that the single Save button at the very
  // bottom of the edit panel submits (via `form={editFormId}`) — it's placed
  // there, past the linked-debt / linked-account pickers, so Save always
  // reads as the last thing in the panel (household request, 2026-09-08),
  // even though those pickers sit outside the form and auto-save on change.
  // A `linked` asset has no such form (name follows the account) — no button.
  const showEstimateForm = !linked && canEstimate && Boolean(asset.estimateDetails);
  const editFormId = linked ? null : `asset-edit-${asset.id}`;
  const editFormPending = showEstimateForm ? estimatePending : pending;

  return (
    <li className="flex flex-col gap-1 rounded-lg border border-blue-100 dark:border-neutral-800 px-3 py-1.5 text-sm">
      {/* Row 1: type icon + friendly name + link icon (left), value (right). */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span title={typeTooltip} className="shrink-0 text-gray-400 dark:text-neutral-500">
            {asset.assetType === "CRYPTO" ? (
              <CryptoIcon symbol={cryptoSymbol} size={14} />
            ) : (
              <TypeIcon size={14} aria-hidden="true" />
            )}
          </span>
          <p className="min-w-0 truncate font-medium text-neutral-900 dark:text-neutral-100">{displayName}</p>
          {showDebtLinkIcon && (
            <span
              title={hasLinkedDebt ? `Linked to ${asset.debt!.name}` : "Paid Off (No Loan)"}
              className="shrink-0"
            >
              {hasLinkedDebt ? (
                <Link2 size={14} className="text-blue-700 dark:text-blue-400" />
              ) : (
                <CheckCircle2 size={14} className="text-emerald-700 dark:text-emerald-400" />
              )}
            </span>
          )}
          {showAccountLinkIcon && linkedAccount && (
            <span
              title={`Linked to ${linkedAccount.orgName ?? linkedAccount.displayName ?? linkedAccount.name}`}
              className="shrink-0"
            >
              <Link2 size={14} className="text-blue-700 dark:text-blue-400" />
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => hasLinkedDebt && setExpanded((v) => !v)}
          aria-label={hasLinkedDebt ? (expanded ? "Hide Value Breakdown" : "Show Value Breakdown") : undefined}
          className={`flex shrink-0 items-center gap-1 font-medium text-neutral-900 dark:text-neutral-100 ${hasLinkedDebt ? "" : "cursor-default"}`}
        >
          {hasLinkedDebt && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          {formatCents(hasLinkedDebt ? equityCents : asset.valueCents)}
        </button>
      </div>

      {/* Row 2: institution / linked loan — only when there is one. */}
      {institution && <p className="truncate text-xs text-gray-500 dark:text-neutral-400">{institution}</p>}

      {/* Last row: "As Of <date> • <source>" (left), kebab actions (right). */}
      <RowActions
        dense
        {...rowActionsProps}
        actions={[
              ...(canEstimate && asset.estimateDetails
                ? [
                    {
                      key: "reestimate",
                      icon: Sparkles,
                      label: asset.assetType === "CRYPTO" ? "Live Price" : "Re-Estimate",
                      tone: "emerald",
                      disabled: rerunPending,
                      successToast: asset.assetType === "CRYPTO" ? "Price Updated" : "Estimate Updated",
                      onClick: () => startRerunTransition(() => rerunAssetEstimate(asset.id)),
                    } satisfies RowAction,
                  ]
                : []),
              ...(stale && asset.source === "MANUAL" && !editing
                ? [
                    {
                      key: "confirm",
                      icon: Check,
                      label: "Still Accurate",
                      tone: "amber",
                      disabled: confirmPending,
                      successToast: "Marked Still Accurate",
                      onClick: () => startConfirmTransition(() => confirmAssetValue(asset.id)),
                    } satisfies RowAction,
                  ]
                : []),
              editAction,
              {
                key: "delete",
                icon: Trash2,
                label: linked ? "Stop Tracking" : "Remove",
                tone: "danger",
                disabled: deletePending,
                successToast: linked ? "Stopped Tracking" : "Asset Removed",
                confirmMessage: linked
                  ? `Stop tracking "${displayName}" in net worth? The connected account keeps syncing — you can add it back anytime from "Connected but not counted."`
                  : `Remove "${displayName}"?`,
                onClick: () => startDeleteTransition(() => deleteAsset(asset.id)),
              },
        ]}
      >
        <p
          className={`flex items-center gap-1 text-xs ${stale ? "text-amber-600 dark:text-amber-400 font-medium" : "text-gray-500 dark:text-neutral-400"}`}
        >
          {stale && <AlertTriangle size={12} aria-hidden="true" />}
          As Of {formatDate(asset.asOfDate, { month: "short", day: "numeric", year: "numeric" })}
          {linked && " • Synced"}
          {aiEstimated && " • AI Estimate"}
          {livePriced && " • Live Price"}
          {hasLinkedDebt && " • Equity"}
        </p>
      </RowActions>

      {expanded && hasLinkedDebt && (
        <div className="grid grid-cols-3 gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2 text-xs">
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Full Value</p>
            <p className="font-medium text-neutral-900 dark:text-neutral-100">{formatCents(asset.valueCents)}</p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Owed</p>
            <p className="font-medium text-neutral-900 dark:text-neutral-100">
              {formatCents(asset.debt!.balanceCents)}
            </p>
          </div>
          <div>
            <p className="text-gray-500 dark:text-neutral-400">Equity</p>
            <p
              className={`font-medium ${equityCents < 0 ? "text-red-600 dark:text-red-400" : "text-neutral-900 dark:text-neutral-100"}`}
            >
              {formatCents(equityCents)}
            </p>
          </div>
        </div>
      )}

      {editing && !linked && (
        <div className="flex flex-col gap-3 border-t border-blue-100 dark:border-neutral-800 pt-2">
          {hasLinkedDebt && (
            <p className="text-xs text-gray-500 dark:text-neutral-400">
              This name follows the linked loan — rename it from{" "}
              <NextLink href="/settings/accounts" className="underline">
                Settings → Accounts
              </NextLink>
              .
            </p>
          )}
          {canEstimate && asset.estimateDetails ? (
            // Already AI/live-price-managed — value and asOfDate are
            // computed automatically (see updateAssetEstimateDetails), so
            // the only things left to hand-edit are the name (unless a
            // linked loan already supplies it — see the note above) and the
            // vehicle/home/crypto specifics that drive the estimate.
            <form
              id={editFormId ?? undefined}
              action={(formData) => {
                estimateFormAction(formData);
                setEditing(false);
                setActionsOpen(false);
              }}
              className="flex flex-col gap-2"
            >
              {hasLinkedDebt ? (
                <input type="hidden" name="name" defaultValue={asset.name} />
              ) : (
                <input
                  name="name"
                  defaultValue={asset.name}
                  required
                  className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                />
              )}
              <p className="text-xs text-gray-500 dark:text-neutral-400">
                {asset.assetType === "CRYPTO"
                  ? "Value comes from a live market price — edit the coin or quantity below, not the dollar amount directly."
                  : "Value comes from an AI estimate — edit the details below, not the dollar amount directly."}
              </p>
              <EstimateDetailsFields asset={asset} />
            </form>
          ) : (
            <>
              <form
                id={editFormId ?? undefined}
                action={(formData) => {
                  formAction(formData);
                  setEditing(false);
                  setActionsOpen(false);
                }}
                className="flex flex-col gap-2"
              >
                {hasLinkedDebt ? (
                  <input type="hidden" name="name" defaultValue={asset.name} />
                ) : (
                  <input
                    name="name"
                    defaultValue={asset.name}
                    required
                    className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                  />
                )}
                <div className="flex items-center gap-2">
                  <MoneyInput
                    name="value"
                    defaultCents={asset.valueCents}
                    required
                    className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                  />
                  <input
                    name="asOfDate"
                    type="date"
                    defaultValue={asset.asOfDate.toISOString().slice(0, 10)}
                    required
                    className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                  />
                </div>
              </form>
              {canEstimate && (
                // Not set up yet — offer switching to AI/live-price tracking
                // as an alternative to the manual value above, same fields
                // the old standalone "estimate" form used. A hidden name
                // field carries the current name through unchanged — either
                // renaming already happens in the manual form above, or (for
                // a debt-linked asset) it isn't editable here at all.
                <form
                  action={(formData) => {
                    estimateFormAction(formData);
                    setEditing(false);
                    setActionsOpen(false);
                  }}
                  className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 p-2"
                >
                  <input type="hidden" name="name" defaultValue={asset.name} />
                  <p className="text-xs text-gray-500 dark:text-neutral-400">
                    Or {asset.assetType === "CRYPTO" ? "get a live market price" : "get a rough AI-estimated value"}{" "}
                    instead — fill these in and the amount above updates automatically
                    {asset.assetType === "CRYPTO" ? " every time you load this page" : " once a month"}.
                  </p>
                  <EstimateDetailsFields asset={asset} />
                  <button
                    type="submit"
                    disabled={estimatePending}
                    className="self-end rounded-lg bg-emerald-700 dark:bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {estimatePending
                      ? asset.assetType === "CRYPTO"
                        ? "Pricing…"
                        : "Estimating…"
                      : asset.assetType === "CRYPTO"
                        ? "Get Live Price"
                        : "Get AI Estimate"}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
      {editing && linked && (
        <p className="border-t border-blue-100 dark:border-neutral-800 pt-2 text-xs text-gray-500 dark:text-neutral-400">
          This name follows the connected account — rename it from{" "}
          <NextLink href="/settings/accounts" className="underline">
            Settings → Accounts
          </NextLink>
          .
        </p>
      )}

      {isAppreciable && !showDebtLinkIcon && (
        <div className="flex flex-col gap-2 border-t border-blue-100 dark:border-neutral-800 pt-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400">
            <input
              type="checkbox"
              checked={paidOff}
              disabled={debtLinkPending}
              onChange={(e) => {
                const checked = e.target.checked;
                setPaidOff(checked);
                if (checked) {
                  setAddingLoan(false);
                  if (hasLinkedDebt) startDebtLinkTransition(() => linkAssetDebt(asset.id, ""));
                }
              }}
            />
            Paid Off (No Loan)
          </label>

          {!paidOff && !addingLoan && (
            <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
              Linked Debt (for Equity)
              <SelectField
                value={asset.debtId ?? ""}
                onChange={(v) => {
                  if (v === "__add__") {
                    setAddingLoan(true);
                    return;
                  }
                  if (!v) setPaidOff(true);
                  startDebtLinkTransition(() => linkAssetDebt(asset.id, v));
                }}
                disabled={debtLinkPending}
                small
                options={[
                  { value: "", label: "None" },
                  // The currently-linked loan, if the page's list left it out
                  // (a since-hidden debt still on this asset) — so the picker
                  // shows what it's actually set to rather than a blank.
                  ...(asset.debt && !debts.some((d) => d.id === asset.debt!.id)
                    ? [{ value: asset.debt.id, label: asset.debt.account?.displayName ?? asset.debt.name }]
                    : []),
                  ...debts.map((d) => ({ value: d.id, label: d.name })),
                  { value: "__add__", label: "+ Add a New Loan…" },
                ]}
                className="mt-1"
              />
            </label>
          )}

          {addingLoan && (
            <form action={loanFormAction} className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 p-2">
              <p className="text-xs text-gray-500 dark:text-neutral-400">
                For a lender that doesn&apos;t sync with SimpleFIN (Tesla Financial, a family loan,
                etc.) — creates a regular manual debt and links it here.
              </p>
              <input
                name="name"
                placeholder="Lender (e.g. Tesla Finance)"
                required
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
              />
              <div className="flex gap-2">
                <MoneyInput
                  name="balance"
                  placeholder="Balance $"
                  required
                  className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                />
                <PercentInput
                  name="apr"
                  placeholder="APR %"
                  required
                  className="w-20 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                />
                <MoneyInput
                  name="minPayment"
                  placeholder="Min $/mo"
                  required
                  className="w-24 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-1.5 text-xs focus:border-blue-900 focus:outline-none"
                />
              </div>
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setAddingLoan(false)}
                  className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loanPending}
                  className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {loanPending ? "Adding…" : "Add Loan"}
                </button>
              </div>
              {loanState.error && <p className="text-xs text-red-600 dark:text-red-400">{loanState.error}</p>}
            </form>
          )}
        </div>
      )}

      {canLinkAccount && !showAccountLinkIcon && (
        <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
          Linked Account
          <SelectField
            value={asset.accountId ?? ""}
            onChange={(v) => startLinkTransition(() => linkAssetAccount(asset.id, v))}
            disabled={linkPending}
            small
            options={[
              { value: "", label: "Manual (None)" },
              ...accounts.map((a) => ({ value: a.id, label: a.displayName ?? a.name })),
            ]}
            className="mt-1"
          />
        </label>
      )}

      {/* Single Save button for the whole edit panel, bottom-right — past the
          linked-debt / linked-account pickers above (which auto-save on
          change and sit outside the form). Submits the name/value/estimate
          form via `form={editFormId}` (household request, 2026-09-08). */}
      {editing && editFormId && (
        <div className="flex items-center justify-end gap-3 border-t border-blue-100 dark:border-neutral-800 pt-2">
          {(state.error || estimateState.error) && (
            <p className="min-w-0 flex-1 text-xs text-red-600 dark:text-red-400">
              {state.error ?? estimateState.error}
            </p>
          )}
          <button
            type="submit"
            form={editFormId}
            disabled={editFormPending}
            aria-label="Save"
            title="Save"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-900 text-white disabled:opacity-50 dark:bg-blue-700"
          >
            {editFormPending ? <span aria-hidden>…</span> : <Check size={15} />}
          </button>
        </div>
      )}
    </li>
  );
}
