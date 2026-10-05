"use client";

import { useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Minus, PartyPopper, TrendingDown, TrendingUp } from "lucide-react";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { DebtCompositionChart, type CompositionSlice } from "@/components/debt-composition-chart";
import { useStoredBoolean } from "@/lib/use-stored-boolean";

// Remembers only expand/collapse (not which chart is showing) — that's all
// the user asked to persist. Defaults to collapsed for a first-time visitor.
const STORAGE_KEY = "flow:debts:total-card-expanded";

type Debt = {
  id: string;
  name: string;
  balanceCents: number;
  aprBasisPoints: number;
  debtType: "REVOLVING" | "INSTALLMENT";
  // CARD/LOAN are both REVOLVING (same interest/minimum mechanics), split
  // purely for display — see DebtKind's doc comment in schema.prisma. BNPL
  // is always paired with INSTALLMENT.
  kind: "CARD" | "LOAN" | "BNPL";
};

type View = { title: string; subtitle: string; slices: CompositionSlice[] };

type DebtTrend = { deltaCents: number; sinceDateKey: string };

export function TotalDebtCard({
  debts,
  totalBalanceCents,
  allDebtsPaidOff,
  trend,
}: {
  debts: Debt[];
  totalBalanceCents: number;
  allDebtsPaidOff: boolean;
  trend: DebtTrend | null;
}) {
  const [expanded, setExpanded] = useStoredBoolean(STORAGE_KEY, false);
  const [viewIndex, setViewIndex] = useState(0);

  function toggle() {
    setExpanded(!expanded);
  }

  const owedDebts = debts.filter((d) => d.balanceCents > 0);

  const byDebt: CompositionSlice[] = owedDebts.map((d) => ({ id: d.id, name: d.name, valueCents: d.balanceCents }));

  const byType: CompositionSlice[] = [
    {
      id: "card",
      name: "Credit Cards",
      valueCents: owedDebts.filter((d) => d.kind === "CARD").reduce((s, d) => s + d.balanceCents, 0),
    },
    {
      id: "loan",
      name: "Loans",
      valueCents: owedDebts.filter((d) => d.kind === "LOAN").reduce((s, d) => s + d.balanceCents, 0),
    },
    {
      id: "bnpl",
      name: "BNPL / Installment Plans",
      valueCents: owedDebts.filter((d) => d.kind === "BNPL").reduce((s, d) => s + d.balanceCents, 0),
    },
  ];

  // Installment/BNPL plans don't compound interest (see debt-payoff.ts), so
  // this view is revolving-only — a fixed BNPL schedule isn't "costing" you
  // anything beyond its face value.
  const byInterest: CompositionSlice[] = owedDebts
    .filter((d) => d.debtType === "REVOLVING")
    .map((d) => ({ id: d.id, name: d.name, valueCents: Math.round((d.balanceCents * d.aprBasisPoints) / 10000) }));

  const views: View[] = [
    { title: "By Debt", subtitle: "Share of your total balance", slices: byDebt },
    { title: "By Type", subtitle: "Credit cards, loans, and BNPL/installment plans", slices: byType },
    {
      title: "Yearly Interest Cost",
      subtitle: "What each debt costs you per year in interest, at today's balance and rate",
      slices: byInterest,
    },
  ].filter((v) => v.slices.some((s) => s.valueCents > 0));

  const clampedIndex = views.length > 0 ? ((viewIndex % views.length) + views.length) % views.length : 0;
  const view = views[clampedIndex];

  return (
    <div className="rounded-2xl border border-blue-100 dark:border-neutral-800 p-4">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        disabled={views.length === 0}
        className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-default"
      >
        <div>
          <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Total Debt</h2>
          <p className="text-3xl font-semibold text-blue-900 dark:text-blue-300">{formatCents(totalBalanceCents)}</p>
          {/* Only shown collapsed — the chart view already tells the same
              "what changed" story once expanded, so both at once is noise. */}
          {!expanded && trend && (
            <p
              className={`mt-1 flex items-center gap-1 text-sm font-medium ${
                trend.deltaCents > 0
                  ? "text-red-600 dark:text-red-400"
                  : trend.deltaCents < 0
                    ? "text-emerald-700 dark:text-emerald-400"
                    : "text-gray-500 dark:text-neutral-400"
              }`}
            >
              {trend.deltaCents > 0 ? (
                <TrendingUp size={16} />
              ) : trend.deltaCents < 0 ? (
                <TrendingDown size={16} />
              ) : (
                <Minus size={16} />
              )}
              {trend.deltaCents === 0
                ? "No Change"
                : `${trend.deltaCents > 0 ? "+" : ""}${formatCents(trend.deltaCents)}`}
              <span className="font-normal text-gray-500 dark:text-neutral-400">
                since {formatDate(new Date(trend.sinceDateKey), { month: "short", day: "numeric" })}
              </span>
            </p>
          )}
        </div>
        {views.length > 0 && (
          <ChevronDown
            size={18}
            className={`shrink-0 text-neutral-400 dark:text-neutral-500 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {allDebtsPaidOff && (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <PartyPopper size={16} className="animate-celebrate" /> You&apos;re debt-free! Still watching synced balances for new charges.
        </p>
      )}

      {expanded && view && (
        <div className="mt-4 flex flex-col gap-3 border-t border-blue-100 dark:border-neutral-800 pt-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-comfortaa text-sm font-semibold text-neutral-900 dark:text-neutral-100">{view.title}</p>
              <p className="text-xs text-gray-500 dark:text-neutral-400">{view.subtitle}</p>
            </div>
            {views.length > 1 && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setViewIndex((i) => i - 1)}
                  aria-label="Previous Chart"
                  className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewIndex((i) => i + 1)}
                  aria-label="Next Chart"
                  className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

          <DebtCompositionChart slices={view.slices} />

          {views.length > 1 && (
            <div className="flex items-center justify-center gap-1.5">
              {views.map((v, i) => (
                <button
                  key={v.title}
                  type="button"
                  onClick={() => setViewIndex(i)}
                  aria-label={`Show ${v.title}`}
                  className={`h-1.5 w-1.5 rounded-full ${
                    i === clampedIndex ? "bg-blue-800 dark:bg-blue-400" : "bg-neutral-300 dark:bg-neutral-700"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
