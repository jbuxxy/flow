"use client";

import { useActionState, useRef, useState } from "react";
import { createAsset, type AssetFormState } from "./actions";
import { VehicleEstimateFields } from "./vehicle-estimate-fields";
import { CryptoEstimateFields } from "./crypto-estimate-fields";
import { SelectField } from "@/components/select-field";
import { MoneyInput } from "@/components/money-input";
import { Modal } from "@/components/modal";
import { AddButton } from "@/components/add-button";
import { useActionToast } from "@/lib/use-action-toast";
import { currentDateKey } from "@/lib/period";

const initialState: AssetFormState = {};

const ASSET_TYPE_OPTIONS = [
  { value: "RETIREMENT_401K", label: "401(k)" },
  { value: "RETIREMENT_IRA", label: "IRA" },
  { value: "RETIREMENT_PENSION", label: "Pension" },
  { value: "HOME_EQUITY", label: "Home (Full Value)" },
  { value: "VEHICLE_EQUITY", label: "Vehicle (Full Value)" },
  { value: "INVESTMENT", label: "Investment Account" },
  { value: "CRYPTO", label: "Crypto" },
  { value: "OTHER", label: "Other" },
] as const;

export function AddAssetForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createAsset, initialState);
  // Local-calendar "YYYY-MM-DD" (currentDateKey), not toISOString() — the
  // latter is UTC and defaults this to tomorrow for an evening viewer west
  // of UTC.
  const [today] = useState(() => currentDateKey());
  const [assetType, setAssetType] = useState<(typeof ASSET_TYPE_OPTIONS)[number]["value"]>("OTHER");
  const canEstimate = assetType === "VEHICLE_EQUITY" || assetType === "HOME_EQUITY";
  const isCrypto = assetType === "CRYPTO";
  const formRef = useRef<HTMLFormElement>(null);
  // MoneyInput is controlled (its own internal digit state), so a plain
  // form.reset() doesn't touch it — same reason SelectField needs its state
  // reset explicitly (see use-action-success.ts). Bumping this key remounts
  // it with fresh, blank state instead.
  const [valueKey, setValueKey] = useState(0);

  useActionToast(pending, state, {
    success: "Asset Added",
    onSuccess: () => {
    formRef.current?.reset();
    // Also collapses the vehicle/home estimate section, so re-picking
    // "Vehicle" later mounts a brand-new VehicleEstimateFields instance
    // with fresh internal state instead of the last one's leftover picks.
    setAssetType("OTHER");
    setValueKey((k) => k + 1);
    setOpen(false);
    },
  });

  return (
    <>
      <AddButton label="Add an Asset" onClick={() => setOpen(true)} />
      <Modal open={open} onClose={() => setOpen(false)} title="Add an Asset">
      <form
      ref={formRef}
      action={formAction}
      className="flex flex-col gap-3"
    >
      <input
        name="name"
        placeholder="e.g. Fidelity 401(k)"
        required
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
      />
      <div className="flex gap-2">
        <SelectField
          name="assetType"
          value={assetType}
          onChange={(v) => setAssetType(v as (typeof ASSET_TYPE_OPTIONS)[number]["value"])}
          searchable={false}
          options={ASSET_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          large
          className="flex-1"
        />
        <MoneyInput
          key={valueKey}
          name="value"
          placeholder={canEstimate || isCrypto ? "Value $ (or leave blank)" : "Value $"}
          required={!canEstimate && !isCrypto}
          className="w-40 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-neutral-400">
        For home/vehicle, enter the full value — not equity. If you&apos;re
        tracking the mortgage or auto loan as a debt, it already subtracts
        automatically; entering equity here would subtract it twice.
      </p>

      {canEstimate && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 p-3">
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            Fill these in and leave Value blank to get a rough AI-estimated value instead — a
            general-knowledge ballpark, not a real appraisal, re-checked automatically once a
            month.
          </p>
          {assetType === "VEHICLE_EQUITY" ? (
            <VehicleEstimateFields />
          ) : (
            <>
              <input
                name="address"
                placeholder="Street address, city, state"
                className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
              />
              <div className="flex gap-2">
                <input
                  name="bedrooms"
                  placeholder="Beds"
                  inputMode="numeric"
                  className="w-20 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
                <input
                  name="bathrooms"
                  placeholder="Baths"
                  inputMode="decimal"
                  className="w-20 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
                <input
                  name="sqft"
                  placeholder="Sqft"
                  inputMode="numeric"
                  className="flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none"
                />
              </div>
            </>
          )}
        </div>
      )}

      {isCrypto && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-100 dark:border-neutral-800 p-3">
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            Pick a coin and enter how much you hold to get a live market value instead — a real
            price from CoinGecko, re-checked every time you load this page (not just a monthly
            estimate).
          </p>
          <CryptoEstimateFields />
        </div>
      )}

      <label className="flex flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400">
        As of
        <input
          name="asOfDate"
          type="date"
          required
          defaultValue={today}
          className="mt-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2.5 text-base focus:border-blue-900 focus:outline-none"
        />
      </label>
      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-neutral-300 dark:border-neutral-700 px-4 py-2.5 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add Asset"}
      </button>
      </form>
      </Modal>
    </>
  );
}
