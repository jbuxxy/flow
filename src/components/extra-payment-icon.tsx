"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BanknoteArrowUp } from "lucide-react";
import { formatCents } from "@/lib/money";
import type { PoolBreakdown } from "@/lib/debt-payoff";

// Half-width of the w-56 tooltip, used to clamp it on-screen once portaled.
const TOOLTIP_HALF_W = 112;
const TOOLTIP_MARGIN = 8;

// The small emerald banknote-arrow badge every "extra toward principal" line
// shows (EntryLine, UpcomingBillsCard) — hovering it surfaces the same
// "where did this money come from" breakdown the /debts Payoff Calendar's
// day popover already shows (household request, 2026-09-28: "have this
// everywhere the extra payment icon is used"). Only interactive when there's
// something to reveal beyond the amount already sitting right next to the
// icon — a flat per-paycheck extra with nothing rolled in renders as the
// plain icon it always was.
//
// Portaled to <body> and clamped to the viewport (same trick as
// ChartHoverTooltip) instead of absolute-positioned off the icon — rows near
// the left edge of a narrow mobile screen were pushing the centered w-56 box
// half off-screen, cutting its text off (household report, 2026-09-28).
export function ExtraPaymentIcon({
  poolBreakdown,
  size = 13,
}: {
  poolBreakdown?: PoolBreakdown;
  size?: number;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const parts = poolBreakdown?.parts.filter((p) => p.amountCents > 0) ?? [];
  const hasRolled = parts.some((p) => p.kind === "rolled");

  const icon = <BanknoteArrowUp size={size} className="shrink-0 text-emerald-700 dark:text-emerald-400" />;
  if (!hasRolled) return icon;

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const center = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(center, TOOLTIP_MARGIN + TOOLTIP_HALF_W),
      window.innerWidth - TOOLTIP_MARGIN - TOOLTIP_HALF_W,
    );
    setPos({ left, top: rect.top - 6 });
  };
  const hide = () => setPos(null);

  return (
    <span ref={anchorRef} className="relative inline-flex shrink-0 cursor-help" onMouseEnter={show} onMouseLeave={hide}>
      {icon}
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            role="tooltip"
            className="fixed z-[var(--z-overlay)] w-56 -translate-x-1/2 -translate-y-full rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            style={{ left: Math.round(pos.left), top: Math.round(pos.top) }}
          >
            <span className="flex flex-col gap-1">
              {parts.map((p, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1 text-left text-[11px] font-normal text-emerald-700 dark:text-emerald-400"
                >
                  <BanknoteArrowUp size={11} className="shrink-0" />
                  {formatCents(p.amountCents)} {p.kind === "base" ? "Extra" : `Rolled From ${p.name}`}
                </span>
              ))}
            </span>
          </span>,
          document.body,
        )}
    </span>
  );
}
