import Link from "next/link";
import { FileDown, Sparkles } from "lucide-react";
import { requireFullAccess } from "@/lib/access";
import { AppShell } from "@/components/app-shell";
import { listReportArchive, type ReportArchiveEntry } from "@/lib/reports";
import { currentPeriodKey, periodLabel } from "@/lib/period";

function reportLabel(periodKey: string): string {
  return periodKey === "STARTUP" ? "Startup Report" : periodLabel(periodKey);
}

// A STARTUP report has no month in its periodKey — bucket it (and sort it) by
// the month it was generated. Everything else carries "YYYY-MM" already.
function monthKey(entry: ReportArchiveEntry): string {
  if (entry.periodKey !== "STARTUP") return entry.periodKey;
  return currentPeriodKey(entry.createdAt);
}

function yearOf(entry: ReportArchiveEntry): number {
  return Number(monthKey(entry).slice(0, 4));
}

export default async function ReportArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await requireFullAccess();

  const entries = await listReportArchive(session.user.householdId);
  const { year: yearParam } = await searchParams;

  // One pill per calendar year that has an archived report, newest first.
  // Only shown once the archive spans more than one year — a new year's pill
  // appears the month its January report is archived (≈ that March). The
  // newest year is the default view.
  const years = [...new Set(entries.map(yearOf))].sort((a, b) => b - a);
  const selectedYear =
    yearParam && years.includes(Number(yearParam)) ? Number(yearParam) : (years[0] ?? new Date().getFullYear());
  // The newest year reads newest-first; a past year selected via a pill reads
  // like a bound archive: January through December (household, 2026-09-03).
  const newestFirst = selectedYear === years[0];
  const shown = entries
    .filter((e) => yearOf(e) === selectedYear)
    .sort((a, b) => {
      const cmp = monthKey(a).localeCompare(monthKey(b));
      return newestFirst ? -cmp : cmp;
    });

  return (
    <AppShell
      title="Report Archive"
      user={session.user}
      breadcrumb={{ href: "/reports", label: "Monthly Report" }}
      width={entries.length === 0 ? "reading" : "wide"}
    >
      {entries.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-neutral-400">
          Nothing here yet — the month in progress stays on the Monthly Report page, and lands in the archive once the
          next month&apos;s report is generated.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {years.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {years.map((y) => {
                const active = y === selectedYear;
                return (
                  <Link
                    key={y}
                    href={`/reports/archive?year=${y}`}
                    aria-current={active ? "page" : undefined}
                    className={`rounded-full px-3 py-1 text-sm font-medium ${
                      active
                        ? "bg-blue-900 text-white dark:bg-blue-700"
                        : "border border-blue-100 text-gray-600 dark:border-neutral-800 dark:text-neutral-400"
                    }`}
                  >
                    {y}
                  </Link>
                );
              })}
            </div>
          )}

          <ul className="flex flex-col gap-2 lg:grid lg:grid-cols-2 lg:items-start xl:grid-cols-3">
            {shown.map((r) => (
              <li key={r.id} className="rounded-xl border border-blue-100 p-4 dark:border-neutral-800">
                <a
                  href={`/reports/archive/${r.id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Download ${reportLabel(r.periodKey)} PDF`}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {r.type === "STARTUP" && (
                        <Sparkles size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                      )}
                      {reportLabel(r.periodKey)}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-neutral-400">{r.narrative}</p>
                  </div>
                  <span className="shrink-0 rounded-lg border border-neutral-300 p-2 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    <FileDown size={16} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </AppShell>
  );
}
