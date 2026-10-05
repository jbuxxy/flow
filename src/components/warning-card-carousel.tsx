"use client";

import { Children, cloneElement, isValidElement } from "react";
import { useCollapsedState, type CollapseControlProps } from "@/components/collapsible-warning-card";
import { SwipeCarousel } from "@/components/swipe-carousel";

// Swipeable, one-card-at-a-time carousel for the dashboard's warning cards
// (2026-08-20 — replaces an earlier stacked-cards attempt that didn't read
// well: overlapping semi-transparent cards turned into a muddy mess). The
// actual swipe/height/dot mechanics live in SwipeCarousel (extracted
// 2026-08-22 for the dashboard's content carousel to share) — this
// component's own job is just the collapse-state wiring below.
//
// Every card in here shares ONE collapsed/expanded state (2026-08-20
// follow-up) rather than each tracking its own — independent per-card
// state meant expanding just one left a short, collapsed card next to a
// tall, expanded one, and swiping to the short one produced a big empty
// gap under it (the container still had to fit the tall one sitting
// right next to it in the row). Expand/collapse any card and they all
// follow, via cloneElement injecting the shared collapsed/onToggle into
// each child's CollapsibleWarningCard.
//
// Children need a stable `key` (each caller already passes one) so React
// can track identity as cards come and go — a card can drop out entirely
// between renders (its underlying count hit zero), which just shrinks the
// dot row (handled by SwipeCarousel).
export function WarningCardCarousel({
  children,
  desktopGrid = false,
}: {
  children: React.ReactNode;
  desktopGrid?: boolean;
}) {
  const items = Children.toArray(children).filter(isValidElement);
  const [collapsed, setCollapsed] = useCollapsedState("dashboard-carousel");

  if (items.length === 0) return null;

  return (
    <SwipeCarousel desktopGrid={desktopGrid}>
      {items.map((item) =>
        cloneElement(item as React.ReactElement<CollapseControlProps>, {
          key: item.key,
          collapsed,
          onToggle: () => setCollapsed(!collapsed),
        }),
      )}
    </SwipeCarousel>
  );
}
