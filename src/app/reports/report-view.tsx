"use client";

import { CheckCircle2, XCircle, TrendingUp, TrendingDown } from "lucide-react";
import Link from "next/link";
import { useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";
import { useCountUp } from "@/lib/use-count-up";
import { DonutChart } from "@/components/donut-chart";
import { LINE_SERIES_COLORS } from "@/lib/chart-colors";
import { GOAL_POSTURE_LABEL } from "@/lib/goal-posture";
import { updateGoalPosture } from "@/app/settings/actions";
import { showToast } from "@/lib/toast";
import type { HouseholdGoalPosture } from "@prisma/client";
import type { MonthReport } from "@/lib/monthly-report";
import type { CurrentReportContent, ReportFindings } from "@/lib/reports";

// The Monthly Report reads top-to-bottom like a written report, not a wall
// of notification cards (household request, 2026-09-03): a masthead verdict,
// then the narrative, then the numbers, then what to do about them, then the
// forward-looking notes. One column, hairline-ruled sections, minimal card
// chrome — and the same section order as the PDF (src/lib/report-pdf.tsx) so
// the on-screen report and its export stay in step.
//
// The numbers come from findings.monthSnapshot — the covered month's budget
// FROZEN into the report when it was generated — never a live re-query, so a
// past month's report keeps showing that month's buckets and caps rather than
// whatever's set now (household, 2026-09-03: an August report showing
// September's caps and a bucket that didn't exist in August). Older reports
// have no snapshot: fall back to the frozen top-level totals + the
// overspending-buckets list, and skip the donut. A household with AI reports
// off has no report at all — then the live MonthReport is all there is.

// The month's bucket breakdown, however we got it.
type NormMonth = {
  label: string;
  totalSpentCents: number;
  totalCapCents: number;
  totalIncomeCents: number;
  // null when unknown (an older report with no snapshot) — the "leaned on
  // one-off money" note is suppressed rather than guessed.
  recurringIncomeCents: number | null;
  buckets: { name: string; capCents: number; spentCents: number; achieved: boolean }[];
  // Acknowledged, never totaled — see MonthReport.oneTimePurchases.
  oneTimePurchases: { name: string; capCents: number; spentCents: number }[];
};

function normalizeMonth(
  monthLabel: string,
  findings: ReportFindings | undefined,
  live: MonthReport,
): NormMonth {
  const snap = findings?.monthSnapshot;
  if (snap) {
    return {
      label: monthLabel,
      totalSpentCents: snap.totalSpentCents,
      totalCapCents: snap.totalCapCents,
      totalIncomeCents: snap.totalIncomeCents,
      recurringIncomeCents: snap.recurringIncomeCents,
      buckets: snap.buckets.map((b) => ({ ...b, achieved: b.spentCents <= b.capCents })),
      oneTimePurchases: snap.oneTimePurchases ?? [],
    };
  }
  if (findings) {
    // Older report, pre-snapshot: the frozen top-level totals are still
    // this-month-correct; the per-bucket breakdown is gone, so the bucket
    // table renders from overspendingBuckets and the donut is skipped.
    return {
      label: monthLabel,
      totalSpentCents: findings.totalSpentCents,
      totalCapCents: findings.totalCapCents,
      totalIncomeCents: findings.totalIncomeCents,
      recurringIncomeCents: null,
      buckets: [],
      oneTimePurchases: [],
    };
  }
  // No AI report — the live MonthReport is the only source.
  return {
    label: live.label,
    totalSpentCents: live.totalSpentCents,
    totalCapCents: live.totalCapCents,
    totalIncomeCents: live.totalIncomeCents,
    recurringIncomeCents: live.recurringIncomeCents,
    buckets: live.buckets.map((b) => ({
      name: b.name,
      capCents: b.capCents,
      spentCents: b.spentCents,
      achieved: b.achieved,
    })),
    oneTimePurchases: live.oneTimePurchases,
  };
}

// One stable colour per bucket, keyed by name — used for BOTH its donut wedge
// and its list dot so the two always agree (they used to be indexed
// independently, off an 8-slot palette, so a 9-bucket household saw two
// buckets share a colour, adjacent in the ring). LINE_SERIES_COLORS is the
// shared 10-hue "every item named" palette.
function bucketColors(buckets: { name: string }[]): Map<string, (typeof LINE_SERIES_COLORS)[number]> {
  return new Map(buckets.map((b, i) => [b.name, LINE_SERIES_COLORS[i % LINE_SERIES_COLORS.length]]));
}

type SectionTone = "default" | "warn" | "bad";

const SECTION_TONE: Record<SectionTone, string> = {
  default: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-800 dark:text-amber-300",
  bad: "text-red-700 dark:text-red-400",
};

// One report section: a hairline rule above it, its heading in the right tier
// colour, then its body.
function Section({ title, tone = "default", children }: { title: string; tone?: SectionTone; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-blue-100 pt-4 dark:border-neutral-800">
      <h2 className={`text-sm font-semibold ${SECTION_TONE[tone]}`}>{title}</h2>
      {children}
    </section>
  );
}

// A small understated eyebrow for sub-groups inside a section.
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">{children}</p>
  );
}

function Masthead({ month }: { month: NormMonth }) {
  const surplusCents = month.totalIncomeCents - month.totalSpentCents;
  const inSurplus = surplusCents >= 0;
  const recurringSurplusCents =
    month.recurringIncomeCents != null ? month.recurringIncomeCents - month.totalSpentCents : null;
  const leanedOnIrregular = inSurplus && recurringSurplusCents != null && recurringSurplusCents < 0;
  const spent = useCountUp(month.totalSpentCents);

  return (
    <header className="flex flex-col gap-3 pb-2">
      <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
        {month.label}
      </p>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`flex items-center gap-1.5 text-base font-semibold ${
            inSurplus ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"
          }`}
        >
          {inSurplus ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          {inSurplus ? "Broke Even" : "Short This Month"}
        </span>
        <span
          className={`text-base font-semibold ${
            inSurplus ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"
          }`}
        >
          {inSurplus ? "+" : "−"}
          {formatCents(Math.abs(surplusCents))}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-neutral-400">
        <span>{formatCents(month.totalIncomeCents)} In</span>
        <span>{formatCents(spent)} Out (Incl. Debt)</span>
        <span>{formatCents(month.totalCapCents)} Budgeted</span>
      </div>
      {leanedOnIrregular && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          On recurring income alone, this month ran −{formatCents(Math.abs(recurringSurplusCents!))} — the balance came
          from one-off money.
        </p>
      )}
    </header>
  );
}

function Overview({
  month,
  colors,
}: {
  month: NormMonth;
  colors: Map<string, (typeof LINE_SERIES_COLORS)[number]>;
}) {
  const spent = useCountUp(month.totalSpentCents);
  const segments = month.buckets
    .filter((b) => b.spentCents > 0)
    .map((b) => ({ label: b.name, valueCents: b.spentCents, colorClass: colors.get(b.name)!.stroke }));
  const achievedCount = month.buckets.filter((b) => b.achieved).length;

  return (
    <Section title="Overview">
      <div className="flex flex-col items-center gap-2">
        <DonutChart segments={segments} centerLabel={formatCents(spent)} centerSubLabel="Spent" />
        <p className="text-xs text-gray-500 dark:text-neutral-400">
          {achievedCount} of {month.buckets.length} Buckets on Budget
        </p>
      </div>
    </Section>
  );
}

function PostureRealignment({
  realignment,
}: {
  realignment: NonNullable<ReportFindings["postureRealignment"]>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const suggested = GOAL_POSTURE_LABEL[realignment.suggestedPosture] ?? realignment.suggestedPosture;
  const current = GOAL_POSTURE_LABEL[realignment.currentPosture] ?? realignment.currentPosture;

  return (
    <Section title="Revisit Your Primary Goal" tone="warn">
      <p className="text-sm text-neutral-800 dark:text-neutral-200">
        Your Primary Goal is <span className="font-medium">{current}</span>, but your finances point toward{" "}
        <span className="font-medium">{suggested}</span>.
      </p>
      <p className="text-xs text-gray-600 dark:text-neutral-400">{realignment.rationale}</p>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400 dark:text-neutral-500">Or change it any time at Settings → Household.</p>
        <button
          type="button"
          onClick={() =>
            startTransition(async () => {
              try {
                await updateGoalPosture(realignment.suggestedPosture as HouseholdGoalPosture);
                showToast("Primary Goal Updated");
                router.refresh();
              } catch {
                showToast("Something Went Wrong", "error");
              }
            })
          }
          disabled={pending}
          className="shrink-0 rounded-lg bg-blue-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-blue-700"
        >
          {pending ? "Switching…" : `Switch to ${suggested}`}
        </button>
      </div>
    </Section>
  );
}

// The bucket table — every bucket, over-cap ones first, overspend inline.
function BucketTable({
  month,
  colors,
}: {
  month: NormMonth;
  colors: Map<string, (typeof LINE_SERIES_COLORS)[number]>;
}) {
  const ordered = [...month.buckets].sort((a, b) => {
    if (a.achieved !== b.achieved) return a.achieved ? 1 : -1;
    return b.spentCents - b.capCents - (a.spentCents - a.capCents);
  });

  return (
    <Section title="Where the Money Went">
      <ul className="flex flex-col">
        {ordered.map((b) => {
          const overCents = b.spentCents - b.capCents;
          return (
            <li
              key={b.name}
              className="flex items-center justify-between gap-3 border-b border-blue-100 py-2 text-sm last:border-b-0 dark:border-neutral-800"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colors.get(b.name)!.dot}`} />
                <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">{b.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-gray-500 dark:text-neutral-400">
                  {formatCents(b.spentCents)} / {formatCents(b.capCents)}
                </span>
                {b.achieved ? (
                  <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <span className="flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
                    +{formatCents(overCents)}
                    <XCircle size={15} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// Fallback for an older report with no bucket snapshot — just the buckets
// that ran over, from the frozen findings.
function OverBudgetList({ buckets }: { buckets: ReportFindings["overspendingBuckets"] }) {
  const ordered = [...buckets].sort((a, b) => b.overspendCents - a.overspendCents);
  return (
    <Section title="Where the Money Went">
      <ul className="flex flex-col">
        {ordered.map((b) => (
          <li
            key={b.name}
            className="flex items-center justify-between gap-3 border-b border-blue-100 py-2 text-sm last:border-b-0 dark:border-neutral-800"
          >
            <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">{b.name}</span>
            <span className="shrink-0 text-xs font-medium text-red-600 dark:text-red-400">
              +{formatCents(b.overspendCents)} over
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ReportView({
  current,
  monthLabel,
  report,
  budgetPlanPending = false,
}: {
  current: MonthReport;
  monthLabel: string;
  report: CurrentReportContent | null;
  budgetPlanPending?: boolean;
}) {
  // An ARCHIVED report generated before a findings-shape change is never
  // regenerated once its settle window closes (see reports.ts), so a stored
  // `findings` can be missing keys the current shape has — backfill the
  // arrays and nullable slots so an older report renders its available
  // sections instead of throwing on `undefined.length`.
  const raw = report?.findings as Partial<ReportFindings> | undefined;
  const findings: ReportFindings | undefined = raw && {
    totalSpentCents: raw.totalSpentCents ?? 0,
    totalCapCents: raw.totalCapCents ?? 0,
    totalIncomeCents: raw.totalIncomeCents ?? 0,
    monthSnapshot: raw.monthSnapshot ?? null,
    overspendingBuckets: raw.overspendingBuckets ?? [],
    newBucketSuggestions: raw.newBucketSuggestions ?? [],
    detectedRecurring: raw.detectedRecurring ?? [],
    budgetingIssues: raw.budgetingIssues ?? [],
    budgetCorrection: raw.budgetCorrection ?? null,
    postureSuggestion: raw.postureSuggestion ?? null,
    postureRealignment: raw.postureRealignment ?? null,
    bigSurplusOpportunity: raw.bigSurplusOpportunity ?? null,
    savingsGoalInsights: raw.savingsGoalInsights ?? [],
    budgetPlan: raw.budgetPlan ?? null,
  };

  const month = normalizeMonth(monthLabel, findings, current);
  const colors = bucketColors(month.buckets);
  const hasBucketDetail = month.buckets.length > 0;

  // The deterministic verdict wins over a possibly-stale AI finding: only show
  // the "get back to breakeven" cuts when the month actually ran short.
  const ranShort = month.totalIncomeCents - month.totalSpentCents < 0;
  const showCorrection = ranShort && !!findings?.budgetCorrection;
  const showOpportunities = !!findings && (!!findings.postureSuggestion || !!findings.bigSurplusOpportunity);
  const showNotes =
    !!findings && (findings.budgetingIssues.length > 0 || findings.detectedRecurring.length > 0);
  const showBucketIdeas = !!findings && findings.newBucketSuggestions.length > 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 pb-4">
      <Masthead month={month} />

      {report && (
        <Section title="The Month in Review">
          <div className="border-l-2 border-emerald-300 pl-3 dark:border-emerald-800">
            <Eyebrow>AI Budget Coach</Eyebrow>
            <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-neutral-800 dark:text-neutral-200">
              {report.narrative}
            </p>
          </div>
        </Section>
      )}

      {hasBucketDetail && <Overview month={month} colors={colors} />}

      {hasBucketDetail ? (
        <BucketTable month={month} colors={colors} />
      ) : findings && findings.overspendingBuckets.length > 0 ? (
        <OverBudgetList buckets={findings.overspendingBuckets} />
      ) : null}

      {month.oneTimePurchases.length > 0 && (
        <Section title="One-Time Purchases">
          <p className="text-xs text-gray-500 dark:text-neutral-400">
            Funded outside your monthly budget — not counted in the spending totals above.
          </p>
          <ul className="flex flex-col">
            {month.oneTimePurchases.map((p) => (
              <li
                key={p.name}
                className="flex items-center justify-between gap-3 border-b border-blue-100 py-2 text-sm last:border-b-0 dark:border-neutral-800"
              >
                <span className="truncate font-medium text-neutral-900 dark:text-neutral-100">{p.name}</span>
                <span className="shrink-0 text-xs text-gray-500 dark:text-neutral-400">{formatCents(p.spentCents)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {showCorrection && (
        <Section title="Getting Back to Breakeven" tone="bad">
          <p className="text-xs text-red-700 dark:text-red-400">
            {formatCents(findings!.budgetCorrection!.deficitCents)} over — here&apos;s where to trim.
          </p>
          <ul className="flex flex-col gap-2.5">
            {findings!.budgetCorrection!.suggestedCuts.map((c) => (
              <li key={c.bucketName} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{c.bucketName}</span>
                  <span className="text-red-700 dark:text-red-400">
                    New cap {formatCents(c.suggestedCapCents)} (−{formatCents(c.cutCents)})
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-neutral-400">{c.rationale}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {showOpportunities && (
        <Section title="Making the Most of the Margin">
          <ul className="flex flex-col gap-3">
            {findings!.postureSuggestion && (
              <li className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">
                    {findings!.postureSuggestion.type === "DEBT_PAYDOWN" ? "Pay Down" : "Save Toward"}:{" "}
                    {findings!.postureSuggestion.targetName}
                  </span>
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{formatCents(findings!.postureSuggestion.suggestedAmountCents)}/mo
                  </span>
                </div>
                <p className="text-xs text-gray-500 dark:text-neutral-400">{findings!.postureSuggestion.rationale}</p>
              </li>
            )}
            {findings!.bigSurplusOpportunity && (
              <li className="text-sm">
                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                  Big Surplus: {formatCents(findings!.bigSurplusOpportunity.surplusCents)}
                </span>
                <p className="text-xs text-gray-500 dark:text-neutral-400">{findings!.bigSurplusOpportunity.note}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-neutral-400">
                  {findings!.bigSurplusOpportunity.debtOption && (
                    <span>
                      {findings!.bigSurplusOpportunity.debtOption.name}:{" "}
                      {(findings!.bigSurplusOpportunity.debtOption.aprBasisPoints / 100).toFixed(2)}% APR
                    </span>
                  )}
                  {findings!.bigSurplusOpportunity.savingsOption && (
                    <span>
                      {findings!.bigSurplusOpportunity.savingsOption.name}:{" "}
                      {(findings!.bigSurplusOpportunity.savingsOption.apyBasisPoints / 100).toFixed(2)}% APY
                    </span>
                  )}
                </div>
              </li>
            )}
          </ul>
        </Section>
      )}

      {findings?.postureRealignment && <PostureRealignment realignment={findings.postureRealignment} />}

      {findings && findings.savingsGoalInsights.length > 0 && (
        <Section title="Savings Goals">
          <ul className="flex flex-col gap-2">
            {findings.savingsGoalInsights.map((g) => (
              <li key={g.name} className="text-sm">
                <div className="flex items-center gap-2">
                  {g.onTrack ? (
                    <CheckCircle2 size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <XCircle size={14} className="shrink-0 text-amber-500" />
                  )}
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{g.name}</span>
                </div>
                <p className="ml-[22px] text-xs text-gray-500 dark:text-neutral-400">{g.note}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {showNotes && (
        <Section title="Also Worth Noting">
          {findings!.budgetingIssues.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-neutral-800 dark:text-neutral-200">
              {findings!.budgetingIssues.map((issue, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-neutral-400 dark:text-neutral-500">•</span>
                  {issue}
                </li>
              ))}
            </ul>
          )}

          {findings!.detectedRecurring.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Possible Untracked Bills</Eyebrow>
              <ul className="flex flex-col gap-1">
                {findings!.detectedRecurring.map((r) => (
                  <li key={r.merchant} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-900 dark:text-neutral-100">{r.merchant}</span>
                    <span className="text-gray-500 dark:text-neutral-400">
                      {formatCents(r.amountCents)} · {r.cadence.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {showBucketIdeas && (
        <Section title="New Bucket Ideas">
          <ul className="flex flex-col gap-2">
            {findings!.newBucketSuggestions.map((b) => (
              <li key={b.name} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{b.name}</span>
                  <span className="text-gray-500 dark:text-neutral-400">{formatCents(b.monthlyCapCents)}/mo</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-neutral-400">{b.rationale}</p>
              </li>
            ))}
          </ul>
          {budgetPlanPending && (
            <Link href="/budget" className="self-end text-sm text-blue-800 dark:text-blue-400">
              Set These Up In Your Budget →
            </Link>
          )}
        </Section>
      )}
    </div>
  );
}
