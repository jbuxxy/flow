"use client";

import { useState } from "react";
import { DayOfMonthPicker } from "@/components/day-of-month-picker";

// The two pay days of a SEMI_MONTHLY income (Income.semiMonthlyDays), as
// the `semiMonthlyDay1`/`semiMonthlyDay2` form fields semiMonthlyDaysFromForm
// (income/actions.ts) reads. Rendered only while the cadence select says
// Semi-Monthly.
export function SemiMonthlyDaysFields({
  defaultDays,
  small = false,
}: {
  defaultDays?: readonly number[];
  small?: boolean;
}) {
  const [first, setFirst] = useState(defaultDays?.[0] ? String(defaultDays[0]) : "");
  const [second, setSecond] = useState(defaultDays?.[1] ? String(defaultDays[1]) : "");

  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-2 gap-2">
        <DayOfMonthPicker
          name="semiMonthlyDay1"
          value={first}
          onChange={setFirst}
          label="First Payday"
          small={small}
          lastDayLabel
        />
        <DayOfMonthPicker
          name="semiMonthlyDay2"
          value={second}
          onChange={setSecond}
          label="Second Payday"
          small={small}
          lastDayLabel
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-neutral-400">Pick 31 for the last day of the month.</p>
    </div>
  );
}
