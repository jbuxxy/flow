"use client";

import { useEffect } from "react";

// A portal'd, position:fixed popover/tooltip (see cycle-calendar-view.tsx,
// payoff-projection-chart.tsx) doesn't scroll with the page, so it hangs
// detached from its anchor the moment anything scrolls or the window resizes.
// Dismiss it on either. Capture-phase scroll so a scroll inside any nested
// overflow container counts too. No-op while `active` is false.
export function useDismissOnScroll(active: boolean, onDismiss: () => void): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [active, onDismiss]);
}
