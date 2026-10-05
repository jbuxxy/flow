"use client";

import Link from "next/link";
import { CollapsibleWarningCard, type CollapseControlProps } from "@/components/collapsible-warning-card";

// Same collapsible shell as CountWarning/NeedsSetupWarning/etc. — used for
// the dashboard's plain-boolean signals (bank connection needs attention, AI
// provider needs setup) that don't have a count or a per-item list, so no
// dismiss button, just a link. Lives inside WarningCardCarousel (2026-08-20)
// alongside those other cards rather than stacked below it as a lone plain
// box — it used to render outside the carousel and looked out of place.
export function AttentionLinkCard({
  href,
  title,
  subtitle,
  storageKey,
  collapsed,
  onToggle,
}: {
  href: string;
  title: string;
  subtitle: string;
  // Per rendered instance, like CountWarning — this component gets reused
  // for genuinely different signals (bank sync, AI setup), each collapsing
  // independently outside the carousel's shared-state case.
  storageKey: string;
} & CollapseControlProps) {
  return (
    <CollapsibleWarningCard storageKey={storageKey} color="yellow" title={title} collapsed={collapsed} onToggle={onToggle}>
      <p className="mt-1 text-xs text-neutral-900 dark:text-white">{subtitle}</p>
      <div className="mt-3 flex justify-end">
        <Link href={href} className="text-xs font-medium text-yellow-800 dark:text-yellow-300 underline underline-offset-2">
          Review &rarr;
        </Link>
      </div>
    </CollapsibleWarningCard>
  );
}
