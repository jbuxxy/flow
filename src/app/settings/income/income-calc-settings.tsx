"use client";

import { useState, useTransition } from "react";
import { updateIncomeCalcMethod, setIncludeP2PInIncomeCalc, setAutoApplyAdHocIncomeToBuckets } from "../actions";
import { SelectField } from "@/components/select-field";
import { Switch } from "@/components/switch";
import { showToast } from "@/lib/toast";

async function saved(run: () => Promise<unknown>) {
  try {
    await run();
    showToast("Settings Saved");
  } catch {
    showToast("Couldn’t Save", "error");
  }
}

type IncomeCalcMethod = "MONTHLY_AVERAGE" | "BIWEEKLY_CONSERVATIVE";

// Drives the one figure getIncomeSummary computes for both /income's total
// and /buckets' allocation summary — see IncomeCalcMethod in schema.prisma
// for what each method means.
export function IncomeCalcSettings({
  method,
  includeP2P,
  autoApplyToBuckets,
}: {
  method: IncomeCalcMethod;
  includeP2P: boolean;
  autoApplyToBuckets: boolean;
}) {
  const [selectedMethod, setSelectedMethod] = useState<IncomeCalcMethod>(method);
  const [p2p, setP2p] = useState(includeP2P);
  const [autoApply, setAutoApply] = useState(autoApplyToBuckets);
  const [, startMethodTransition] = useTransition();
  const [p2pPending, startP2pTransition] = useTransition();
  const [autoApplyPending, startAutoApplyTransition] = useTransition();

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-comfortaa text-emerald-700 dark:text-emerald-400">Monthly Income Calculation</span>
        <SelectField
          value={selectedMethod}
          onChange={(v) => {
            const next = v as IncomeCalcMethod;
            setSelectedMethod(next);
            startMethodTransition(() => saved(() => updateIncomeCalcMethod(next)));
          }}
          searchable={false}
          options={[
            { value: "MONTHLY_AVERAGE", label: "Monthly Average (Includes 3rd Paycheck Months)" },
            { value: "BIWEEKLY_CONSERVATIVE", label: "Biweekly × 2 (Ignores 3rd Paycheck Months)" },
          ]}
        />
        <span className="text-xs font-normal text-gray-500 dark:text-neutral-400">
          {selectedMethod === "MONTHLY_AVERAGE"
            ? "Biweekly income is spread evenly across all 12 months, so months with a 3rd paycheck get folded into the average."
            : "Biweekly income counts as exactly 2 paychecks a month. Months with a 3rd paycheck come in ahead of plan instead of being averaged in."}
        </span>
      </label>

      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          <span className="font-comfortaa text-emerald-700 dark:text-emerald-400">Include P2P Income</span>
          <span className="block text-xs font-normal text-gray-500 dark:text-neutral-400">
            Counts this month&apos;s P2P credits toward the total
          </span>
        </span>
        <Switch
          checked={p2p}
          disabled={p2pPending}
          ariaLabel="Include P2P Income"
          onChange={() => {
            const next = !p2p;
            setP2p(next);
            startP2pTransition(() => saved(() => setIncludeP2PInIncomeCalc(next)));
          }}
        />
      </label>

      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          <span className="font-comfortaa text-emerald-700 dark:text-emerald-400">
            Auto-Apply Extra Income To Over Buckets
          </span>
          <span className="block text-xs font-normal text-gray-500 dark:text-neutral-400">
            When a bucket goes over its cap, this month&apos;s still-unspent P2P/ad hoc income (never a tracked
            paycheck, so a 3rd-paycheck month is never touched) automatically covers it instead of leaving it red.
            Only once a bucket has actually gone over — never early in the month on a pace guess.
          </span>
        </span>
        <Switch
          checked={autoApply}
          disabled={autoApplyPending}
          ariaLabel="Auto-Apply Extra Income To Over Buckets"
          onChange={() => {
            const next = !autoApply;
            setAutoApply(next);
            startAutoApplyTransition(() => saved(() => setAutoApplyAdHocIncomeToBuckets(next)));
          }}
        />
      </label>
    </div>
  );
}
