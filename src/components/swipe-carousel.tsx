"use client";

import { Children, isValidElement, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";

// Generic swipeable, one-slide-at-a-time carousel — the mechanics originally
// built for WarningCardCarousel (2026-08-20), extracted 2026-08-22 so the
// dashboard's content carousel (bills/payoff-calendar/buckets/net-worth)
// could reuse them without duplicating ~50 lines or fighting over
// WarningCardCarousel's hardcoded "dashboard-carousel" collapse-state key.
//
// Slides via CSS transform + overflow-hidden, not native overflow-x-auto
// scroll (see WarningCardCarousel's original comment — some browsers show a
// scrollbar despite the usual hide-scrollbar utility classes; transform +
// overflow-hidden can never show one, by construction). Height animates to
// match whichever slide is active via ResizeObserver, so very differently
// shaped slides (a bills list vs. a calendar grid vs. a chart) never leave
// dead space below a shorter one, or a gap before the dot row. Touch swipe
// is a plain threshold check on touchstart/touchend (no live drag-follow),
// same trade-off as the original — paired with prev/next chevron buttons in
// a right-aligned row above the slides (same look as the Total Debt card's
// chart switcher; shown at every width, since the dots are a fiddly click
// target and there's no mouse-drag equivalent of the swipe).
//
// Nothing inside a slide should itself swipe horizontally — a nested
// horizontal scroller fights this one for the same gesture (the buckets
// card used to paginate its tiles this way; it's a plain wrapping grid now,
// see bucket-grid.tsx).
//
// A slide whose content renders to nothing (measured height 0) is dropped
// from the active rotation and the dot row — a dismissable warning card
// that just lost its last row renders `null` but its element stays in
// `children` until the next server render, and without this an emptied
// slide that happened to be active pinned the shared viewport height to 0
// and hid every other slide until a manual refresh. The slide stays
// mounted and observed, so it rejoins automatically if its content comes
// back (e.g. the content carousel's bills slide after a bill is re-added).
const SWIPE_THRESHOLD_PX = 40;

type SlideKey = string | number;

// `desktopGrid`: at `lg:`+ drop the one-at-a-time carousel entirely and lay
// every slide out in a wrapping row instead (every dashboard carousel has
// room for that on a wide screen and swiping is a phone affordance).
// Flexbox (`flex flex-wrap` + each item `grow shrink basis-[280px]`), not
// CSS Grid — a `grid-cols-[repeat(auto-fit,minmax(280px,1fr))]` used to do
// this, but grid computes its column *tracks* once for the whole grid, not
// per row: a short trailing row (e.g. 2 leftover slides after a full row of
// 4) still reserves the same number of tracks the full rows use, so the
// leftover slides sat stranded on the left with dead space to their right
// instead of the row reflowing around it (2026-09-23 bug — "This Month's
// Buckets"/"Net Worth" landed alone on a half-empty row). A fixed
// `columns-N` has the mirror-image problem: a carousel with only 2 live
// slides (e.g. the dashboard's warning stack on a quiet day) would render 2
// narrow cards and blank columns stranding half *every* row (2026-09-22
// bug). Flexbox's `flex-grow` resolves per *line*, not per grid, so both
// cases just work: every row's items grow to fill exactly their own row's
// width, at whatever count-per-row fits `basis-[280px]` — no hardcoded
// `xl:`/`2xl:` breakpoints needed. `capCardWidth` (see its own doc below)
// swaps that per-row fill for a 420px cap + `justify-center` instead, for
// the one carousel whose cards can't just stretch to fill leftover width.
// Trade-off: `items-start` (not a true masonry) means a short card can
// leave dead space below itself if its row-mate is taller, but that beats
// stranding a third or more of a row empty. Implemented as two sibling
// containers over the *same* `items` with the same keys, switched by CSS
// only (`lg:hidden` / `hidden lg:flex`) — no matchMedia, no hydration
// branch, no extra effect. Cost: the flex branch also mounts its children
// (one branch is `display:none`), so a heavy slide like CycleCalendarView
// mounts twice — bounded and acceptable for the dashboard's fixed slide
// set.
export function SwipeCarousel({
  children,
  desktopGrid = false,
  capCardWidth = false,
  defaultKey,
  autoPlayMs,
}: {
  children: React.ReactNode;
  desktopGrid?: boolean;
  // Caps each `desktopGrid` card at 420px and centers a row that doesn't
  // fill (rather than growing cards to fill it) — see the `desktopGrid`
  // comment above for why: fine for a fluid chart, visibly sparse for a
  // fixed-pixel grid like BucketGrid. Only the dashboard's content carousel
  // (bills/calendar/buckets/net worth/savings) has that kind of card, so
  // this defaults off — every other `desktopGrid` carousel (warnings, Quick
  // Confirm/Payday/Paid-Off) is plain text/pills with nothing that looks
  // odd stretched, and a 2-card row centering with a wide gap instead of
  // filling read as broken there (household report, 2026-09-23).
  capCardWidth?: boolean;
  // Which slide opens active, by its React key — independent of DOM order.
  // Without this the carousel always opens on the first slide (household
  // request, 2026-09-06: a new "Last Week's Bills" retrospective card should
  // lead the carousel so a swipe-left lands on it, but the dashboard should
  // still *open* on "This Week's Bills" as it always has, not the new first
  // slide). Only meaningful on mount — doesn't fight a household's own swipe
  // afterward, and a key that isn't (or is no longer) live just falls back
  // to the first live slide same as leaving this unset.
  defaultKey?: SlideKey;
  // Opt-in auto-advance, in ms between slides (e.g. 10_000) — off unless
  // set, so a warnings/review-card carousel (action items, not something to
  // passively browse) never auto-advances. Runs while `autoPlaying` is true;
  // any deliberate navigation (a chevron, a dot, a swipe, an arrow key) sets
  // it false via userGoTo below, same as a real slideshow pausing itself the
  // moment someone takes the wheel — the Play/Pause toggle between the two
  // chevrons is the only way back to auto-advancing (household request,
  // 2026-09-25; also the WCAG 2.2.2 "Pause, Stop, Hide" requirement for any
  // auto-advancing content lasting more than a few seconds).
  autoPlayMs?: number;
}) {
  const items = Children.toArray(children).filter(isValidElement) as React.ReactElement[];
  // Children.toArray scopes each key for safe flattening — a plain
  // `key="bills"` comes back as `.$bills`, not "bills" (real bug,
  // 2026-09-06: defaultKey="bills" never matched anything, so the carousel
  // always fell back to the first live slide regardless). Strip that known
  // prefix back off so `keys` holds the exact strings a caller's own JSX
  // `key` and `defaultKey` props use — this is also what gets handed back
  // as each slide's own `key` below, which stays fine either way (React only
  // needs it stable and unique, not un-mangled).
  const keys: SlideKey[] = items.map((item, i) =>
    typeof item.key === "string" ? item.key.replace(/^\.\$/, "") : (item.key ?? i),
  );
  const keySignature = keys.join(" ");

  const slideRefs = useRef<Map<SlideKey, HTMLDivElement>>(new Map());
  const touchStartX = useRef<number | null>(null);
  // Carousel viewport wrapper — used by the keyboard handler below to work
  // out whether the arrow press was meant for this carousel.
  const rootRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef(false);
  const [activeKey, setActiveKey] = useState<SlideKey | null>(defaultKey ?? null);
  // Measured content height per slide key. Absent = not measured yet
  // (treated as visible); 0 = rendered nothing (dropped from rotation).
  const [sizes, setSizes] = useState<Record<string, number>>({});

  // One observer across every slide — feeds both the empty-slide check and
  // the active-slide height binding below. Re-runs when the set of slides
  // changes (a card dropped out, or came back, on a server render).
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setSizes((prev) => {
        let next = prev;
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.slideKey;
          if (key === undefined) continue;
          const h = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).scrollHeight;
          if (next[key] !== h) {
            if (next === prev) next = { ...prev };
            next[key] = h;
          }
        }
        return next;
      });
    });
    for (const el of slideRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [keySignature]);

  // Derived at render time, not synced via a setState-in-effect (this
  // project's lint config flags that — see WORKING_ON.md's Theme section).
  const liveDomIndices = items.map((_, i) => i).filter((i) => sizes[String(keys[i])] !== 0);
  const pickedDom = activeKey !== null ? keys.indexOf(activeKey) : -1;
  const activeDom = liveDomIndices.includes(pickedDom) ? pickedDom : (liveDomIndices[0] ?? 0);
  const activeDot = Math.max(0, liveDomIndices.indexOf(activeDom));
  const height = sizes[String(keys[activeDom])];

  function goTo(dot: number) {
    const clamped = Math.min(liveDomIndices.length - 1, Math.max(0, dot));
    setActiveKey(keys[liveDomIndices[clamped]]);
  }

  // Auto-advance, opt-in via autoPlayMs (see its own doc comment). Only
  // `userGoTo` below (a real chevron/dot/swipe/arrow-key navigation) ever
  // sets this false — the timer itself calls the raw `goTo`, not `userGoTo`,
  // so it doesn't pause itself on its own advance. Wraps from the last slide
  // back to the first, standard slideshow behavior. Re-armed on every
  // activeDot change (not a single repeating interval) so each slide always
  // gets its own full autoPlayMs on screen, including the one just landed on
  // via a manual nudge that left autoPlaying on.
  const [autoPlaying, setAutoPlaying] = useState(autoPlayMs !== undefined);
  useEffect(() => {
    if (!autoPlaying || autoPlayMs === undefined || liveDomIndices.length <= 1) return;
    const id = setTimeout(() => goTo((activeDot + 1) % liveDomIndices.length), autoPlayMs);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlaying, autoPlayMs, activeDot, liveDomIndices.length, keySignature]);

  function userGoTo(dot: number) {
    if (autoPlayMs !== undefined) setAutoPlaying(false);
    goTo(dot);
  }

  // Left/right arrow keys step the carousel (household request, 2026-09-10:
  // keyboard parity with the touch swipe and the chevrons). Window-level
  // so it works without first clicking a dot, but both dashboard carousels
  // mount this component, so a press only lands here when this carousel is
  // the one the user is looking at: focus is inside it, the pointer is over
  // it, or — the mouse/keyboard-only case — its viewport box straddles the
  // vertical middle of the screen (the two carousels are far enough apart
  // that at most one does). Typing in a field or holding a modifier is left
  // alone. `navRef` keeps the effect's listener pointed at the current
  // render's userGoTo/activeDot without re-binding it on every render.
  const navRef = useRef<(dir: 1 | -1) => void>(() => {});
  useEffect(() => {
    navRef.current = (dir) => userGoTo(activeDot + dir);
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (dir === 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const root = rootRef.current;
      if (!root || root.offsetParent === null) return; // hidden (e.g. lg: grid)
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      const focused = root.contains(document.activeElement);
      const rect = root.getBoundingClientRect();
      const mid = window.innerHeight / 2;
      const centered = rect.top < mid && rect.bottom > mid;
      if (!focused && !hoveredRef.current && !centered) return;
      e.preventDefault();
      navRef.current(dir);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (items.length === 0) return null;
  if (items.length === 1) return <>{items[0]}</>;

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    userGoTo(activeDot + (deltaX < 0 ? 1 : -1));
  }

  const atStart = activeDot === 0;
  const atEnd = activeDot === liveDomIndices.length - 1;
  // Every slide measured empty (e.g. each warning card's rows dismissed
  // client-side, so each renders null while the server still counts it).
  // Taken out of flow rather than unmounted/`display:none` — the slides stay
  // laid out so the ResizeObserver still sees one come back — but no longer
  // a flex item, so it stops claiming the page's gap-6 gutter. That empty
  // shell was a visible ~24-36px hole between the stat tiles and the content
  // carousel (household report, 2026-09-29).
  const allEmpty = liveDomIndices.length === 0;

  return (
    <>
    <div
      ref={rootRef}
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      className={[desktopGrid ? "lg:hidden" : "", allEmpty ? "pointer-events-none invisible absolute inset-x-0" : ""].join(" ").trim() || undefined}
      aria-hidden={allEmpty || undefined}
    >
      {liveDomIndices.length > 1 && (
        <div className="mb-1 flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => userGoTo(activeDot - 1)}
            disabled={atStart}
            aria-label="Previous Slide"
            title="Previous"
            className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 disabled:pointer-events-none disabled:opacity-30 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <ChevronLeft size={16} />
          </button>
          {autoPlayMs !== undefined && (
            <button
              type="button"
              onClick={() => setAutoPlaying((v) => !v)}
              aria-label={autoPlaying ? "Pause Slideshow" : "Resume Slideshow"}
              title={autoPlaying ? "Pause Slideshow" : "Resume Slideshow"}
              className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
            >
              {autoPlaying ? <Pause size={14} /> : <Play size={14} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => userGoTo(activeDot + 1)}
            disabled={atEnd}
            aria-label="Next Slide"
            title="Next"
            className="rounded-full p-1 text-neutral-400 hover:text-neutral-700 disabled:pointer-events-none disabled:opacity-30 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      <div className="relative">
        <div style={{ height }} className="overflow-hidden transition-[height] duration-200">
          <div
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            style={{ transform: `translateX(-${activeDom * 100}%)` }}
            className="flex transition-transform duration-200 ease-out"
          >
            {items.map((item, i) => (
              <div
                key={keys[i]}
                data-slide-key={String(keys[i])}
                ref={(el) => {
                  if (el) slideRefs.current.set(keys[i], el);
                  else slideRefs.current.delete(keys[i]);
                }}
                className="h-fit w-full shrink-0"
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>

      {liveDomIndices.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1.5">
          {liveDomIndices.map((domIdx, dot) => (
            <button
              key={keys[domIdx]}
              type="button"
              onClick={() => userGoTo(dot)}
              aria-label={`Go to Slide ${dot + 1} of ${liveDomIndices.length}`}
              aria-current={dot === activeDot}
              className={`relative h-1.5 rounded-full transition-all before:absolute before:-inset-2 before:content-[''] ${
                dot === activeDot ? "w-4 bg-blue-800 dark:bg-blue-400" : "w-1.5 bg-blue-200 dark:bg-neutral-700"
              }`}
            />
          ))}
        </div>
      )}
    </div>

    {desktopGrid && (
      <div
        // Hidden outright once every card wrapper is itself `empty:hidden` —
        // same "no empty shell eating a gap" reason as `allEmpty` above.
        className={`hidden lg:flex lg:flex-wrap lg:items-start lg:gap-4 lg:[&:not(:has(>:not(:empty)))]:hidden ${capCardWidth ? "lg:justify-center" : ""}`}
      >
        {items.map((item, i) => (
          <div
            key={keys[i]}
            className={`empty:hidden lg:grow lg:shrink lg:basis-[280px] ${capCardWidth ? "lg:max-w-[420px]" : ""}`}
          >
            {item}
          </div>
        ))}
      </div>
    )}
    </>
  );
}
