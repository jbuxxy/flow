"use client";

import { useEffect, useState, useTransition } from "react";
import { getVehicleMakes, getVehicleModels } from "./vehicle-lookup-actions";
import { SelectField } from "@/components/select-field";

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 1980 + 2 }, (_, i) => CURRENT_YEAR + 1 - i);
const CONDITION_OPTIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR"] as const;

const inputClass =
  "rounded-lg border border-neutral-300 dark:border-neutral-700 px-2 py-2 text-sm focus:border-blue-900 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed";

const modeButtonClass = (active: boolean) =>
  `flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
    active
      ? "border-blue-900 dark:border-blue-400 bg-blue-50 dark:bg-blue-950/40 text-blue-900 dark:text-blue-300"
      : "border-neutral-300 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400"
  }`;

// Year and make are always pickable; model only enables once a make is
// chosen (populated from NHTSA for that make), and trim only enables once a
// model is chosen — there's no free lookup for trim specifically (see
// vehicle-lookup.ts), so it stays a plain text field rather than a fake
// dropdown, just gated the same way for a consistent flow.
//
// "Other" mode (trailers, anything odd) skips the NHTSA lookup entirely in
// favor of a plain description — NHTSA's own trailer-type make list is
// ~9,500 entries dominated by commercial/semi-trailer manufacturers, not
// something worth surfacing as a picker here. See VehicleEstimateDetails in
// src/lib/ai.ts for how the description reaches the actual AI estimate.
export function VehicleEstimateFields({
  defaultYear,
  defaultMake,
  defaultModel,
  defaultTrim,
  defaultMileage,
  defaultCondition,
  defaultDescription,
}: {
  defaultYear?: number;
  defaultMake?: string;
  defaultModel?: string;
  defaultTrim?: string;
  defaultMileage?: number;
  defaultCondition?: string;
  defaultDescription?: string;
}) {
  const [mode, setMode] = useState<"vehicle" | "other">(defaultDescription ? "other" : "vehicle");
  const [year, setYear] = useState(defaultYear ? String(defaultYear) : "");
  const [make, setMake] = useState(defaultMake ?? "");
  const [model, setModel] = useState(defaultModel ?? "");
  const [condition, setCondition] = useState(defaultCondition ?? "GOOD");
  const [makes, setMakes] = useState<string[]>(defaultMake ? [defaultMake] : []);
  const [models, setModels] = useState<string[]>(defaultModel ? [defaultModel] : []);
  const [makesPending, startMakesTransition] = useTransition();
  const [modelsPending, startModelsTransition] = useTransition();

  useEffect(() => {
    if (mode !== "vehicle") return;
    startMakesTransition(() => {
      getVehicleMakes().then((fetched) => {
        setMakes((prev) => Array.from(new Set([...prev, ...fetched])).sort((a, b) => a.localeCompare(b)));
      });
    });
    // Fetch once we're actually in vehicle mode, not on every mode toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode === "vehicle"]);

  useEffect(() => {
    if (!make) return;
    startModelsTransition(() => {
      getVehicleModels(make).then((fetched) => {
        const keepCurrent = model && !fetched.includes(model) ? [model] : [];
        setModels(Array.from(new Set([...keepCurrent, ...fetched])).sort((a, b) => a.localeCompare(b)));
      });
    });
    // Re-runs only when `make` changes — `model` is read for a one-time
    // merge, not something a make change should re-trigger on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [make]);

  return (
    <>
      <div className="flex gap-2">
        <button type="button" onClick={() => setMode("vehicle")} className={modeButtonClass(mode === "vehicle")}>
          Car / Truck
        </button>
        <button type="button" onClick={() => setMode("other")} className={modeButtonClass(mode === "other")}>
          Trailer / Other
        </button>
      </div>

      {mode === "vehicle" ? (
        <>
          <div className="flex gap-2">
            <SelectField
              name="year"
              value={year}
              onChange={setYear}
              placeholder="Year"
              options={YEARS.map((y) => ({ value: String(y), label: String(y) }))}
              className="w-24"
            />
            <SelectField
              name="make"
              value={make}
              onChange={(v) => {
                setMake(v);
                setModel("");
              }}
              placeholder={makesPending && makes.length === 0 ? "Loading Makes…" : "Make"}
              options={makes.map((m) => ({ value: m, label: m }))}
              className="flex-1"
            />
          </div>
          <div className="flex gap-2">
            <SelectField
              name="model"
              value={model}
              onChange={setModel}
              disabled={!make}
              placeholder={
                !make ? "Pick a Make First" : modelsPending && models.length === 0 ? "Loading Models…" : "Model"
              }
              options={models.map((m) => ({ value: m, label: m }))}
              className="flex-1"
            />
            <div className="relative flex-1">
              <input
                name="trim"
                placeholder={model ? "e.g. Elite" : "Pick a Model First"}
                defaultValue={defaultTrim ?? ""}
                disabled={!model}
                className={`w-full pr-12 ${inputClass}`}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-neutral-500">
                Trim
              </span>
            </div>
          </div>
          <div className="relative">
            <input
              name="mileage"
              placeholder="e.g. 45,000"
              defaultValue={defaultMileage ?? ""}
              inputMode="numeric"
              className={`w-full pr-14 ${inputClass}`}
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-neutral-500">
              Miles
            </span>
          </div>
        </>
      ) : (
        <textarea
          name="description"
          placeholder="Describe it — brand, size, year, anything you know. e.g. “2019 Rainier travel trailer, 28ft, bought used in 2022”"
          defaultValue={defaultDescription ?? ""}
          rows={3}
          className={`w-full resize-none ${inputClass}`}
        />
      )}

      <SelectField
        name="condition"
        value={condition}
        onChange={setCondition}
        searchable={false}
        options={CONDITION_OPTIONS.map((c) => ({ value: c, label: c.charAt(0) + c.slice(1).toLowerCase() }))}
        className="w-full"
      />
    </>
  );
}
