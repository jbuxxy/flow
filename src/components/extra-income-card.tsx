"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatISODate } from "@/lib/date";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

export type ExtraIncomeCardSource = {
  id: string;
  name: string;
  occurredOn: string; // ISO date
  amountCents: number;
  applied: { bucketName: string; amountCents: number }[];
};

// This month's ad hoc/P2P income as a pool (getExtraIncomeSummary,
// bucket-ad-hoc-topup.ts): what landed, what auto-apply has drawn into
// over-cap buckets, and what's still waiting. No carry-over — whatever is
// still waiting when the month closes is that month's surplus (household
// rule, 2026-10-07), so the card says so instead of leaving it hidden in
// Bucket Caps vs. Monthly Income's "left to allocate".
export function ExtraIncomeCard({
  receivedCents,
  appliedCents,
  unappliedCents,
  sources,
  autoApply,
  monthEndLabel,
}: {
  receivedCents: number;
  appliedCents: number;
  unappliedCents: number;
  sources: ExtraIncomeCardSource[];
  autoApply: boolean;
  monthEndLabel: string; // e.g. "Oct 31"
}) {
  const [expanded, setExpanded] = useStoredBoolean("buckets-extra-income-expanded", false);
  if (receivedCents <= 0) return null;

  return (
    <div className="rounded-2xl border border-emerald-200 dark:border-emerald-900/60 p-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 text-left"
      >
        <div className="shrink-0">
          <h2 className="text-base font-semibold text-emerald-700 dark:text-emerald-400">Extra Income This Month</h2>
          <p className="mt-1 text-2xl font-semibold text-blue-900 dark:text-blue-300">
            {formatCents(receivedCents)}{" "}
            <span className="text-sm font-normal text-gray-500 dark:text-neutral-400">Received</span>
          </p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-neutral-400">
            <span className="font-medium text-emerald-700 dark:text-emerald-400">{formatCents(appliedCents)} Applied</span>
            {" · "}
            <span className="font-medium text-blue-800 dark:text-blue-300">{formatCents(unappliedCents)} Waiting</span>
          </p>
        </div>
        {/* Desktop-only collapsed split bar — Applied vs. Waiting out of
            what was received, filling the row's empty right side instead of
            leaving the headline alone against the chevron. */}
        {!expanded && (
          <div className="hidden lg:ml-auto lg:block lg:max-w-md lg:flex-1 lg:self-center">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-blue-50 dark:bg-neutral-800">
              <div className="h-full bg-emerald-500" style={{ width: `${(appliedCents / receivedCents) * 100}%` }} />
              <div className="h-full bg-blue-500" style={{ width: `${(unappliedCents / receivedCents) * 100}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px]">
              <span className="text-emerald-700 dark:text-emerald-400">{formatCents(appliedCents)} Applied</span>
              <span className="text-blue-800 dark:text-blue-300">{formatCents(unappliedCents)} Waiting</span>
            </div>
          </div>
        )}
        <ChevronDown
          size={18}
          className={`mt-1 shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>

      <p className="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
        {autoApply ? (
          <>Covers buckets that go over their cap. Whatever&apos;s left on {monthEndLabel} counts as surplus.</>
        ) : (
          <>
            Auto-apply is off, so all of it counts as surplus on {monthEndLabel}. Turn it on in{" "}
            <Link href="/settings/income" className="underline">
              Settings
            </Link>
            .
          </>
        )}
      </p>

      {expanded && (
        <ul className="mt-3 flex flex-col gap-2 border-t lg:grid lg:grid-cols-2 lg:gap-x-8 xl:grid-cols-3 border-blue-100 dark:border-neutral-800 pt-3">
          {sources.map((s) => (
            <li key={s.id} className="text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-neutral-800 dark:text-neutral-200">{s.name}</span>
                <span className="shrink-0 text-neutral-600 dark:text-neutral-400">
                  {formatCents(s.amountCents)} · {formatISODate(s.occurredOn, { month: "short", day: "numeric" })}
                </span>
              </div>
              {s.applied.map((a) => (
                <p key={a.bucketName} className="pl-3 text-xs text-emerald-700 dark:text-emerald-400">
                  → {a.bucketName} +{formatCents(a.amountCents)}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
