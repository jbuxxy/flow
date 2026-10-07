// Presentational pieces for the expanded detail panel on /settings/accounts
// (see ExpandableSummary). No hooks and no server-only imports, so both the
// server page and the client ManualDebtEditor render them.
import { Check, CircleDashed } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { CADENCE_LABEL } from "@/lib/cadence-label";
import type { BnplScheduleRow } from "@/lib/bnpl-schedule";
import type { BillCadence } from "@prisma/client";

export type DetailTone = "default" | "good" | "bad" | "warn" | "muted";

const TONE: Record<DetailTone, string> = {
  default: "text-neutral-900 dark:text-neutral-100",
  good: "text-emerald-700 dark:text-emerald-400",
  bad: "text-red-600 dark:text-red-400",
  warn: "text-amber-700 dark:text-amber-400",
  muted: "text-neutral-400 dark:text-neutral-500",
};

export function DetailGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</dl>;
}

export function DetailTile({
  label,
  value,
  tone = "default",
  wide = false,
}: {
  label: string;
  value: React.ReactNode;
  tone?: DetailTone;
  wide?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-blue-50 bg-blue-50/40 px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-900/60 ${
        wide ? "col-span-2" : ""
      }`}
    >
      <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-neutral-400">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm font-semibold ${TONE[tone]}`}>{value}</dd>
    </div>
  );
}

export function DetailSection({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{title}</h4>
        {aside && <span className="text-[11px] text-gray-500 dark:text-neutral-400">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export const shortDate = (iso: string) =>
  formatDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), { month: "short", day: "numeric", year: "numeric" });

export function cadenceLabel(cadence: BillCadence | null | undefined): string {
  return cadence ? CADENCE_LABEL[cadence] : "—";
}

export type ActivityItem = { id: string; date: string; label: string; amountCents: number; pending?: boolean };

// Recent payments / recent activity — newest first. `signFlip` renders a
// money-out amount as negative (an asset account's spending); debt payments
// read as plain positive amounts paid toward the debt.
export function ActivityList({ items, empty, signFlip = false }: { items: ActivityItem[]; empty: string; signFlip?: boolean }) {
  if (items.length === 0) return <p className="text-xs text-gray-500 dark:text-neutral-400">{empty}</p>;
  return (
    <ul className="divide-y divide-blue-50 overflow-hidden rounded-xl border border-blue-50 dark:divide-neutral-800 dark:border-neutral-800">
      {items.map((t) => {
        const shown = signFlip ? -t.amountCents : t.amountCents;
        return (
          <li key={t.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs">
            <span className="w-14 shrink-0 tabular-nums text-gray-500 dark:text-neutral-400">
              {formatDate(new Date(`${t.date.slice(0, 10)}T00:00:00Z`), { month: "short", day: "numeric" })}
            </span>
            <span className="min-w-0 flex-1 truncate text-neutral-700 dark:text-neutral-300">
              {t.label}
              {t.pending && <span className="ml-1.5 text-amber-700 dark:text-amber-400">Pending</span>}
            </span>
            <span
              className={`shrink-0 font-medium tabular-nums ${
                signFlip ? (shown >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-neutral-900 dark:text-neutral-100") : "text-emerald-700 dark:text-emerald-400"
              }`}
            >
              {formatCents(shown)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Every installment of a BNPL plan as a vertical timeline: paid (emerald
// check, real matched date/amount), the next one due (highlighted), and the
// rest projected.
export function BnplScheduleList({ rows }: { rows: BnplScheduleRow[] }) {
  return (
    <ol className="relative flex flex-col">
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        return (
          <li key={r.number} className="relative flex items-stretch gap-3">
            <div className="relative flex w-5 shrink-0 justify-center">
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute top-5 bottom-0 w-px ${
                    r.status === "PAID" ? "bg-emerald-300 dark:bg-emerald-800" : "bg-neutral-200 dark:bg-neutral-800"
                  }`}
                />
              )}
              <span
                className={`relative z-10 mt-1.5 flex h-4 w-4 items-center justify-center rounded-full ${
                  r.status === "PAID"
                    ? "bg-emerald-600 text-white dark:bg-emerald-500"
                    : r.status === "NEXT"
                      ? "bg-blue-900 text-white ring-4 ring-blue-100 dark:bg-blue-500 dark:ring-blue-950"
                      : "border border-neutral-300 bg-white text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
                }`}
              >
                {r.status === "PAID" ? <Check size={10} strokeWidth={3} /> : r.status === "UPCOMING" ? <CircleDashed size={9} /> : null}
              </span>
            </div>
            <div
              className={`mb-1.5 flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs ${
                r.status === "NEXT" ? "bg-blue-50 dark:bg-blue-950/40" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`font-medium ${
                    r.status === "UPCOMING" ? "text-neutral-500 dark:text-neutral-400" : "text-neutral-900 dark:text-neutral-100"
                  }`}
                >
                  Payment {r.number}
                </span>
                {r.status === "NEXT" && (
                  <span className="rounded-full bg-blue-900 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-blue-600">
                    Next
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-3 tabular-nums">
                <span className="text-gray-500 dark:text-neutral-400">
                  {r.date ? shortDate(r.date) : r.status === "PAID" ? "Paid Before Tracking" : "—"}
                </span>
                <span
                  className={`w-16 text-right font-semibold ${
                    r.status === "PAID"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : r.status === "NEXT"
                        ? "text-blue-900 dark:text-blue-300"
                        : "text-neutral-500 dark:text-neutral-400"
                  }`}
                >
                  {formatCents(r.amountCents)}
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
