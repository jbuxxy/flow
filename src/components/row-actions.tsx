"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { MoreVertical, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { showToast } from "@/lib/toast";

export type RowAction = {
  key: string;
  icon: LucideIcon;
  label: string;
  // May return a promise — `fire()` awaits it before showing `successToast`, so
  // the confirmation lands after the write, not after dispatch.
  onClick?: () => void | Promise<unknown>;
  // Fired via showToast() once `onClick` resolves. Omit for panel-openers
  // (`keepOpen`) — nothing completed yet.
  successToast?: string;
  href?: string; // renders as a Link instead of a button when set
  // Matches each action's pre-consolidation color (household feedback,
  // 2026-09-05 — every icon had gone flat gray): "default" is the plain
  // Edit/Move/Rename blue every row used to use, "danger" is Delete's red,
  // "emerald" is the income/tracking/re-estimate accent, "amber" is the
  // asset "still accurate" confirm.
  tone?: "default" | "danger" | "emerald" | "amber";
  disabled?: boolean;
  // Every destructive action must set this — RowActions gates the click on
  // window.confirm() itself so gating can't be forgotten/dropped by a future
  // caller, matching this app's existing confirm()-before-delete convention
  // everywhere else (see WORKING_ON.md).
  confirmMessage?: string;
  // For an action whose whole job is opening an inline panel elsewhere in
  // the row (Move, Track As Recurring) rather than completing something —
  // firing it must NOT also close this drawer, or the panel opening reads as
  // "nothing happened" (real report, 2026-09-05: tapping Move looked like it
  // just closed the actions drawer). The drawer stays open until the caller
  // explicitly closes it (see `open`/`onOpenChange` below) — typically via
  // the same X that toggled it, or once the opened panel's own action
  // completes.
  keepOpen?: boolean;
  // Narrow escape hatch from "destructive actions are always spelled out as
  // a word, never a bare icon" (household rule, 2026-09-07 — see
  // isWordAction below) — for a row too narrow to fit that word pill
  // without it visually colliding with the kebab/close X next to it (real
  // report, 2026-09-11: Bucket Settings' category list, a short label +
  // Rename + Delete all competing for very little width). Still always red,
  // still always confirm()-gated via confirmMessage — only the word-vs-icon
  // choice changes. Not a general style preference; use only when a row's
  // own width genuinely can't fit the word.
  forceIcon?: boolean;
};

// A row's Edit/Delete/etc. tools, behind one bottom-right trigger. `children`
// is that same bottom line's own content (a date, a cadence string, whatever
// — always the last/only line in the row, per household convention: the
// kebab sits bottom-right everywhere). Clicking the trigger slides the
// *entire* line left by exactly the revealed strip's width — real iMessage-
// style swipe-to-delete, not a popover: the content is one positioned layer
// on top of the (always-rendered) actions layer, so opening both slides the
// content aside AND flips the actions layer visible (opacity, not paint-over
// — see actionsRef's own comment below for why); whatever the content's own
// left edge pushes past the container's bounds is clipped by
// overflow-hidden, not reflowed/truncated. Works identically via click on
// desktop or touch on mobile — no drag tracking needed, since the reveal is
// a CSS transform keyed off `open`.
export function RowActions({
  actions,
  dense = false,
  open: controlledOpen,
  onOpenChange,
  pinned = false,
  extraBoundaryRef,
  children,
}: {
  actions: RowAction[];
  dense?: boolean;
  // Uncontrolled (no `open`/`onOpenChange`) by default — this is what every
  // call site but transaction-row.tsx uses. transaction-row.tsx controls it
  // so a `keepOpen` action's own panel can force this drawer shut once it
  // finishes (see fire()'s "click Move [the panel's submit] should close
  // everything" — RowActions has no other way to be closed from outside),
  // and so the X can close that panel too, not just this drawer.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  // While a `keepOpen` action has opened an inline editor elsewhere in the
  // row, an incidental tap outside the row should NOT collapse the drawer —
  // a half-filled edit form has no business vanishing because you tapped the
  // background (household request, 2026-09-07). With `pinned`, only the
  // drawer's own X (or an explicit action) closes it; the caller sets this
  // while its edit form is showing and clears it on save/cancel.
  pinned?: boolean;
  // A `keepOpen` action's own panel typically renders elsewhere in the same
  // row — not nested inside this component's own DOM — so a click inside it
  // looks like a click *outside* RowActions to the listener below and force-
  // closes the drawer right back (real report, 2026-09-05: picking a bucket
  // in Move's panel closed the whole thing instead of registering). Pass a
  // ref to that row's outer element and clicks anywhere inside it also count
  // as "inside" for that check.
  extraBoundaryRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [, startActionTransition] = useTransition();
  const open = controlledOpen ?? uncontrolledOpen;
  // useCallback (not a plain closure) so the pointerdown effect below can
  // list it as a real dependency instead of the exhaustive-deps lint just
  // being silenced — it only actually changes when controlledOpen/
  // onOpenChange do, so this doesn't cost extra re-subscriptions beyond
  // what correctness already requires.
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );
  const [revealPx, setRevealPx] = useState(0);
  // How much room `children` has left before the kebab, measured fresh
  // right before opening (see measureSlack() below) — the reveal spends
  // that slack first and only actually pushes `children` left by whatever's
  // left over, not by the full action width regardless of how much room
  // already existed (real household report, 2026-09-05: short lines were
  // yanked across their own empty space for no reason).
  const [gapPx, setGapPx] = useState(0);
  const containerRef = useRef<HTMLSpanElement>(null);
  const actionsRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Only worth listening while this row is actually open — a closed
    // row's "is the click outside?" check can only ever call setOpen(false)
    // on something that's already false. A list page can render a hundred-
    // plus rows at once (transactions, bucket singles, bills…), each its own
    // RowActions instance; registering a document-wide pointerdown listener
    // per row regardless of open state meant every single click on the page
    // ran through all of them. Gating on `open` cuts that down to however
    // many rows are actually open right now — realistically 0 or 1.
    if (pinned || !open) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      const inside =
        containerRef.current?.contains(target) || extraBoundaryRef?.current?.contains(target);
      if (!inside) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned, open, extraBoundaryRef, setOpen]);

  // The actions strip is always rendered (just invisible while closed — see
  // actionsRef's own comment further down), so its real width is measurable
  // up front — no flash-of-wrong-size on first open. This mount-time
  // measurement is only a first guess, though — see toggle() below for why
  // it gets a fresh re-measure right before every open too.
  useEffect(() => {
    if (actionsRef.current) setRevealPx(actionsRef.current.getBoundingClientRect().width);
  }, [actions.length, dense]);

  function toggle() {
    if (!open) {
      // Re-measure fresh, not just trust the mount-time effect above — a
      // row that mounts before its own layout has fully settled (real
      // report, 2026-09-14: a Bucket Settings category row's kebab-turned-
      // close-X was hidden once opened) can catch actionsRef at 0 width,
      // which zeroes revealDistance below and leaves the kebab sitting
      // exactly where the now-higher-z-index actions strip paints over it
      // — invisible, not just mispositioned. Same "don't trust a stale
      // snapshot, measure again right before it matters" principle gapPx
      // already uses one line down.
      if (actionsRef.current) setRevealPx(actionsRef.current.getBoundingClientRect().width);
      setGapPx(measureSlack());
    }
    setOpen(!open);
  }

  // How much room `children` actually has left before the kebab — measured
  // against whichever of its rendered fragments is level with the kebab,
  // not the flex row's leftover space. Those agree for single-line content,
  // but once a long subline wraps (a date/account/category line that's just
  // too long for the row), the flex algorithm has already squeezed the
  // wrapper down to make room for that wrap, so its *own* leftover space
  // reads ~0 even though word-wrapping rarely fills a line edge-to-edge —
  // the line beside the kebab typically still has real slack the flex
  // measurement can't see (real report, 2026-09-05: a wrapped 2-line
  // subline got shoved almost off-screen to "reveal" actions it already had
  // room for). Filtered to fragments level with the kebab (not just the
  // *last* one) because content always carries its own transform (even
  // translateX(0)), which makes it establish its own stacking context and
  // paint above the plain kebab button wherever they visually overlap — the
  // strip now aligns everything to the bottom (items-end, see above) so an
  // earlier line sits strictly above the kebab and is filtered out
  // regardless of its own width, rather than either forcing every line to
  // fit (this row shifting unnecessarily) or trusting DOM order to match
  // visual order (an earlier line, if it were level with the kebab, could
  // still cover the close X — both real reports, 2026-09-05). Range.
  // getClientRects() fragments by rendered line (or by flex-wrap row, for a
  // pill-based `children` like bill-row's) regardless of wrapping mechanism,
  // so this generalizes to both.
  function measureSlack(): number {
    if (!contentRef.current || !kebabRef.current) return 0;
    const range = document.createRange();
    range.selectNodeContents(contentRef.current);
    const rects = Array.from(range.getClientRects());
    if (rects.length === 0) return 0;
    const kebabRect = kebabRef.current.getBoundingClientRect();
    const levelWithKebab = rects.filter((r) => r.bottom > kebabRect.top && r.top < kebabRect.bottom);
    const relevant = levelWithKebab.length > 0 ? levelWithKebab : rects;
    const widestRight = Math.max(...relevant.map((r) => r.right));
    return Math.max(0, kebabRect.left - widestRight);
  }

  // The covering strip always retreats by the full action width (plus a
  // small buffer, see revealDistance below) — anything less than that only
  // half-uncovers the actions layer underneath (it's a single opaque slab;
  // shrinking its own translate just exposes a sliver of the *rightmost*
  // actions instead of all of them). `children` gets a second, opposite
  // transform layered on top to cancel out however much of that retreat
  // `measureSlack()` already found free, capped so it never cancels more
  // than the strip actually moved — the two cancel to exactly 0 when there's
  // enough slack, and land `children` flush against the kebab when there
  // isn't.
  //
  // Kebab-to-first-action buffer: without this, the kebab's own resting spot
  // once open lands pixel-exact against the first revealed action — two
  // separate tap targets touching with zero margin. A tap meant for that
  // action can land on the kebab instead (it's the one on top, z-10) and
  // just closes the drawer right back up (real report, 2026-09-05: tapping
  // "Move" on a transaction did this). revealDistance pads the strip's own
  // retreat (and content's counter-shift cap, so a slack-having row still
  // doesn't move more than it has to) by this amount — the actions layer's
  // own width/position is untouched, this only opens a hairline of visible
  // background between the kebab and whatever's revealed next to it.
  const KEBAB_ACTIONS_GAP_PX = 6;
  const revealDistance = revealPx > 0 ? revealPx + KEBAB_ACTIONS_GAP_PX : 0;
  const contentCounterShiftPx = Math.min(revealDistance, gapPx);

  function fire(a: RowAction) {
    if (a.confirmMessage && !confirm(a.confirmMessage)) return;
    if (!a.keepOpen) setOpen(false);
    if (!a.onClick) return;
    const run = a.onClick;
    startActionTransition(async () => {
      try {
        await run();
        if (a.successToast) showToast(a.successToast);
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  }

  const toneClass: Record<NonNullable<RowAction["tone"]>, string> = {
    default: "text-blue-900 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-neutral-800",
    // Always red, not just on hover — a hover-only color is invisible on
    // touch (real report, 2026-09-07: on an iPhone, the "danger"-toned
    // trash can just sat flat gray forever since there's no hover state to
    // trigger it).
    danger: "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40",
    emerald: "text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40",
    amber: "text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40",
  };

  // A destructive action is always spelled out as a word, never a bare icon —
  // "only destructive are words" (household rule, 2026-09-07). So even in
  // `dense` mode (icons only for everything else) a danger-tone action
  // renders its label as red text — no icon — sized (h-8, no vertical
  // padding of its own) to sit inline with the round icon buttons.
  const isWordAction = (a: RowAction) => a.tone === "danger" && !a.forceIcon;
  const itemClass = (a: RowAction) => {
    const tone = toneClass[a.tone ?? "default"];
    if (dense) {
      // h-6 for the word pill: the row is only as tall as its text, and an
      // h-8 pill used to stretch it. The round icon buttons match the
      // kebab's own h-7 w-7 -my-1 instead (real report, 2026-09-09: the
      // pencil's hover circle read visibly smaller than the kebab/close
      // one right next to it) — -my-1 keeps its *occupied* row height at
      // 20px same as before, only the painted hover circle grows to match.
      return isWordAction(a)
        ? `flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium whitespace-nowrap disabled:opacity-40 ${tone}`
        : `flex -my-1 h-7 w-7 shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${tone}`;
    }
    return `flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap disabled:opacity-40 ${tone}`;
  };

  if (actions.length === 0) {
    return <span className="flex min-w-0 flex-1 items-center justify-between gap-2">{children}</span>;
  }

  return (
    <span
      // clip-path, not overflow-hidden: the only thing that needs masking is
      // the content layer's left edge overhanging once its wrapper
      // translates left to reveal the actions strip (see below). Plain
      // `overflow-x-hidden` looked like the fix but isn't — per spec, a
      // non-`visible` overflow-x paired with the (default) `visible`
      // overflow-y computes the y axis to `auto`, so the browser still
      // clips vertically, just via a scrollbar instead of silently (real
      // report, 2026-09-09: kebab/action hover circles still cut off, plus a
      // stray vertical scrollbar per row). `inset(-9999px 0)` clips flush at
      // the container's left/right edges while leaving top/bottom
      // uncontained, so the kebab's and revealed actions' hover circles
      // (deliberately taller than the row — see the kebab's -my-1 below)
      // paint in full.
      className="relative flex min-w-0 flex-1 items-center"
      style={{ clipPath: "inset(-9999px 0)" }}
      ref={containerRef}
      // While the drawer is open this whole strip belongs to the actions —
      // the subline content has slid out of the way. A stray tap that lands
      // in the hairline gap between the kebab and the first action (or on a
      // clipped icon edge) would otherwise fall through to a row's own
      // expand-toggle and just collapse/expand the row, which reads as "the
      // icon doesn't work" (real report, 2026-09-08: the "Track As Recurring"
      // icon "just collapses or expands the entry"). Swallowing the click
      // here only while `open` keeps the closed-state behaviour — where taps
      // on the date/badge subline *should* toggle the row — untouched.
      onClick={open ? (e) => e.stopPropagation() : undefined}
    >
      <span
        // items-end, not items-center — the kebab is meant to sit bottom-
        // right (see the component doc comment above), and for wrapped
        // multi-line `children` that also keeps it level with only the
        // *last* line instead of straddling upward into an earlier one.
        // measureSlack() below relies on that: an earlier line no longer
        // vertically overlaps the kebab, so it's genuinely irrelevant to
        // collision no matter how long it is — centering had made every
        // line equally "at risk," which is what forced the choice between
        // this row unnecessarily shifting (checking only the last line,
        // 2026-09-05) or a wide earlier line blocking the close X
        // afterward (checking every line's own width, same day).
        className="relative z-10 flex min-w-0 flex-1 items-end transition-transform duration-200 ease-out"
        style={{ transform: `translateX(-${open ? revealDistance : 0}px)` }}
      >
        <span
          ref={contentRef}
          // block, not flex — this only ever wraps the one `children` node,
          // so flex bought nothing here, and it cost measureSlack() dearly:
          // a flex container forces its child to blockify (CSS "used value
          // of display is block for a flex item"), and a blockified element
          // reports one rect for its *whole* box from getClientRects() —
          // spanning every wrapped line at once — instead of fragmenting by
          // rendered line. That bogus whole-box rect was winning the "widest
          // line" comparison below outright (real report, 2026-09-05: a
          // wrapped subline moved unnecessarily again right after the fix
          // for the close-X-blocked bug, because this rect's `.right` — an
          // artifact of wherever flex-shrink happened to leave the box, not
          // of anything actually rendered — beat every genuine line rect).
          //
          // This box is flex-assigned however much width was left after the
          // kebab regardless of how much of it the rendered text actually
          // reaches (that's just how flex-shrink negotiates against the
          // zero-basis spacer below: it always lands on this item, wrapped
          // or not) — so it can still visually reach the kebab even when
          // its own *text* doesn't. transform (even translateX(0)) always
          // creates a stacking context, which by itself would paint that
          // mostly-empty box *above* a plain kebab button wherever they
          // overlap — briefly "fixed" by moving this to `left` instead (no
          // stacking context of its own), but animating `left` on a flex
          // child is exactly the case iOS Safari is known to glitch on:
          // every frame reflows instead of compositing, and it visibly
          // jumped through wrong intermediate positions instead of sliding
          // (real report, 2026-09-05, on-device — Playwright's Chromium
          // never reproduced it). Back to `transform` for that reason; see
          // the kebab's own `relative z-10` below for how the paint-order
          // problem actually gets solved instead.
          className="block min-w-0 transition-transform duration-200 ease-out"
          style={{ transform: `translateX(${open ? contentCounterShiftPx : 0}px)` }}
        >
          {children}
        </span>
        <span aria-hidden className="min-w-0 flex-1" />
        <button
          ref={kebabRef}
          type="button"
          onClick={(e) => {
            // Only this button and the revealed actions below stop the
            // click from bubbling to a row's own outer expand-toggle (e.g.
            // TransactionRow's role="button" header) — `children` used to
            // sit behind a blanket stopPropagation on this whole component,
            // which silently ate a tap anywhere in the subline (a date, a
            // classification badge) that wasn't already its own nested
            // button with its own stopPropagation (real household report,
            // 2026-09-06: only the merchant/amount line expanded a row,
            // not the line below it).
            e.stopPropagation();
            toggle();
          }}
          aria-label={open ? "Close Actions" : "Row Actions"}
          title={open ? "Close" : "Actions"}
          // relative z-10 — content above always carries a transform (even
          // translateX(0)), which always creates its own stacking context
          // regardless of how wide its actual visible text is (see its
          // comment). Without this, a plain static kebab button paints
          // *under* any stacking context it overlaps, DOM order or not — a
          // real z-index is what lets the kebab win instead: explicit z-10
          // beats content's implicit z-index:auto outright, no reliance on
          // DOM order needed (real report, 2026-09-05: the close X on a
          // fully-collapsed row went dead once content stopped moving out
          // of the way, since its box stayed just as wide either way).
          // -my-1: the button only *occupies* 20px of row height (negative
          // margin, not overflow clipping — see the container's
          // overflow-x-hidden above) — so a short single-line row (a net-
          // worth "As Of …" line, a bill's status pills) stays tight to its
          // text instead of being stretched to 28px. The 16px icon and the
          // full 28px hover circle both still paint fine; only the layout
          // box the row reserves shrinks to 20px.
          className="relative z-10 -my-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-blue-50 hover:text-blue-900 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-blue-300"
        >
          {open ? <X size={16} /> : <MoreVertical size={16} />}
        </button>
      </span>
      <span
        ref={actionsRef}
        // Always rendered (so its width is measurable up front — see
        // revealPx above) but genuinely invisible while closed: opacity-0 +
        // pointer-events-none, not just a lower z-index painted over by an
        // opaque content layer. That paint-over approach used to require
        // every caller whose own card tints its background (pattern-row.tsx's
        // reimbursement cards) to pass a matching `contentBgClassName`, and
        // even then a translucent card tint (bg-emerald-50/30) painted a
        // *second* translucent layer on top of itself — visibly darker than
        // the rest of the card — while still not being fully opaque enough
        // to hide this strip underneath, so the actions read as already
        // revealed the instant this row first mounted, before ever being
        // tapped (real report, 2026-09-14, on a reimbursement pattern row
        // nested inside a just-expanded bill card). opacity fixes both at
        // once: there's nothing left to paint-match, so no caller prop is
        // needed, and "invisible" no longer depends on some other layer's
        // opacity being 100%. z-0/z-20 stays alongside it for the *open*
        // case — see the block comment below for why that still matters
        // once this strip is actually visible.
        className={`absolute right-0 top-0 flex h-full items-end gap-1 ${open ? "z-20 opacity-100" : "z-0 opacity-0 pointer-events-none"}`}
      >
        {/* z-0 while closed is now belt-and-suspenders (opacity-0 above
            already hides this strip regardless of paint order); z-20 once
            open is still load-bearing. The content layer's `contentRef`
            child carries its own transform (a stacking context) and is
            flex-sized to the full width left of the kebab regardless of how
            far its text actually reaches (see its comment), so even after
            the layer translates aside its box still overlaps — and paints
            above — the leftmost action, silently eating that action's hover
            + click (real report, 2026-09-08: the first icon, "Track As
            Recurring", was dead with no hover cursor while the second,
            "Move", worked). Lifting the whole strip above the content layer
            while open is what actually frees every action; the kebab got its
            own `relative z-10` for the same reason. */}
        {actions.map((a) => {
          const Icon = a.icon;
          const word = isWordAction(a);
          const inner = (
            <>
              {!word && <Icon size={dense ? 16 : 14} />}
              {(!dense || word) && a.label}
            </>
          );
          return a.href ? (
            <Link
              key={a.key}
              href={a.href}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              title={a.label}
              className={itemClass(a)}
            >
              {inner}
            </Link>
          ) : (
            <button
              key={a.key}
              type="button"
              disabled={a.disabled}
              onClick={(e) => {
                e.stopPropagation();
                fire(a);
              }}
              title={a.label}
              aria-label={a.label}
              className={itemClass(a)}
            >
              {inner}
            </button>
          );
        })}
      </span>
    </span>
  );
}
