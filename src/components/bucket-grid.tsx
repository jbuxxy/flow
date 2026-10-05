import Link from "next/link";
import { BucketCircleTile } from "./bucket-circle-tile";
import type { BucketProgress } from "@/lib/buckets";

// Every bucket's status circle in one wrapping 4-up grid — no horizontal
// pagination. The dashboard's whole content carousel already swipes
// horizontally between cards (bills / payoff / buckets / net worth), and a
// second horizontal swipe nested inside the buckets card fought it: a swipe
// meant to page the bucket tiles kept landing on the next carousel card
// instead (household report, 2026-09-07 — 10 buckets, so page 2 held just 2
// tiles and was a pain to reach). A grid that simply grows taller has no
// competing gesture; SwipeCarousel animates its own height to match.
//
// Capped at 3 rows (12 tiles), not 4 (household request, 2026-09-12) — big
// enough that most households never see the overflow tile at all, but keeps
// this card from growing noticeably taller than its Payment Calendar/Net
// Worth/Bucket Spending siblings (all ~340-400px) once a household has more
// than a dozen buckets; "View All" (this card's own header link, or the
// overflow tile itself) is one tap away either way.
const MAX_TILES = 12;

// Shrunk from BucketCircleTile's own 68px/6px default (household follow-up,
// 2026-09-12: "fit them in 340") — at 68px, 3 full rows plus this card's
// header/padding came out to ~378px, taller than its ~340px carousel
// siblings. 56px/5 is the smallest reduction that lands 3 rows (+ the
// tightened gap-y-3 below) back under 340px with a few px to spare, worked
// out against this card's actual header/padding budget in page.tsx.
const TILE_SIZE = 56;
const TILE_STROKE = 5;

export function BucketGrid({ buckets }: { buckets: BucketProgress[] }) {
  const overflow = buckets.length > MAX_TILES;
  const shown = overflow ? buckets.slice(0, MAX_TILES - 1) : buckets;
  const hiddenCount = buckets.length - shown.length;

  return (
    <div className="grid grid-cols-4 gap-x-1 gap-y-3">
      {shown.map((b) => (
        <BucketCircleTile key={b.id} progress={b} size={TILE_SIZE} strokeWidth={TILE_STROKE} />
      ))}
      {overflow && (
        <Link
          href="/buckets"
          className="flex flex-col items-center gap-1.5 rounded-2xl p-1 text-center transition hover:bg-blue-50 dark:hover:bg-neutral-900"
        >
          <span className="flex h-[56px] w-[56px] items-center justify-center rounded-full border border-dashed border-blue-200 text-sm font-semibold text-blue-900 dark:border-neutral-700 dark:text-blue-300">
            +{hiddenCount}
          </span>
          <p className="line-clamp-1 w-full text-[11px] font-medium text-gray-500 dark:text-neutral-400">View All</p>
        </Link>
      )}
    </div>
  );
}
