import { formatCents } from "@/lib/money";
import { formatShortDate } from "@/lib/date";

export type AdHocIncomeEntry = {
  id: string;
  name: string;
  amountCents: number;
  occurredOn: string; // ISO date
};

// Distinct from ExpectedIncomeThisMonth (tracked, scheduled Income records)
// — this is one-off/irregular money in that's still isIncome:true but was
// never turned into a tracked Income, e.g. a P2P credit labeled "counts as
// income" (haircuts, a side gig paid over Venmo). See
// getAdHocIncomeThisMonth (src/lib/income.ts). Unlike Expected This Month's
// total, this one only grows as payments actually land — there's no
// schedule to know about ahead of time.
export function AdHocIncomeCard({ entries, totalCents }: { entries: AdHocIncomeEntry[]; totalCents: number }) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Other Income This Month</h2>
        <span className="shrink-0 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          +{formatCents(totalCents)}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-neutral-800 dark:text-neutral-200">{e.name}</span>
            <span className="shrink-0 text-neutral-600 dark:text-neutral-400">
              {formatCents(e.amountCents)} · {formatShortDate(e.occurredOn)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
