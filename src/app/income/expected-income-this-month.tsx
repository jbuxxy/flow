import { CheckCircle2, Circle } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatISODate } from "@/lib/date";

export type ExpectedIncomeEntry = {
  id: string;
  name: string;
  amountCents: number;
  received: boolean;
  receivedDate: string | null; // ISO date
  expectedDate: string; // ISO date
};

function formatShortDate(iso: string): string {
  return formatISODate(iso, { month: "short", day: "numeric" });
}

// The Income counterpart to bills' ExpectedThisMonth — same shape, "still
// expected" flipped to mean money coming in rather than going out.
export function ExpectedIncomeThisMonth({ incomes }: { incomes: ExpectedIncomeEntry[] }) {
  if (incomes.length === 0) return null;

  // The total set at the start of the month — every tracked income's full
  // amount, received or not. Doesn't shrink as paychecks land; that's what
  // the per-row checkmarks are for.
  const totalExpectedCents = incomes.reduce((s, i) => s + i.amountCents, 0);

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Expected This Month</h2>
        <span className="shrink-0 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          {formatCents(totalExpectedCents)}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {incomes.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-neutral-800 dark:text-neutral-200">
              {i.received ? (
                <CheckCircle2 size={16} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Circle size={16} className="shrink-0 text-neutral-300 dark:text-neutral-600" />
              )}
              <span className="truncate">{i.name}</span>
            </span>
            <span className="shrink-0 text-neutral-600 dark:text-neutral-400">
              {formatCents(i.amountCents)} · {formatShortDate(i.received ? i.receivedDate! : i.expectedDate)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
