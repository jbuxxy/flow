"use client";

import { useEffect, useState } from "react";

// Latches `true` the first time the resolved element is at least `threshold`
// visible, then stops observing — a one-shot "has this scrolled/swiped into
// view yet?" for intro animations. Returns `true` right away under
// prefers-reduced-motion (and if IntersectionObserver is missing / rejects
// the target) so callers fall straight through to the resting state.
//
// `getEl` is called once, inside the effect — pass a closure that reads a
// ref's `.current` (or something derived from it, e.g. an SVG child's
// `.ownerSVGElement`, since a `transform: scaleY(0)` <g> is a zero-height box
// that can never intersect).
export function useFirstInView(
  getEl: () => Element | null | undefined,
  threshold = 0.3,
): boolean {
  // Reduced-motion is knowable synchronously (no ref/DOM element needed,
  // unlike getEl() below) — determining it via useState's lazy initializer
  // instead of a setState call inside the effect avoids an extra render and
  // satisfies react-hooks/set-state-in-effect, which otherwise flags a
  // setState called unconditionally at the top of an effect body as work
  // that didn't need the effect at all.
  const [inView, setInView] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  });

  useEffect(() => {
    if (inView) return; // already resolved above (reduced motion)

    const el = getEl();
    if (!el || typeof IntersectionObserver === "undefined") {
      // Unlike the reduced-motion check above, this genuinely can't move to
      // the lazy useState initializer — getEl() reads a ref, and refs aren't
      // attached yet during that first render. There's also nothing to
      // subscribe to here (that's the whole point of this branch: we
      // *can't* observe), so there's no external callback to defer this
      // into either — it's the terminal "give up and resolve" case.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true);
      return;
    }

    try {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setInView(true);
            io.disconnect();
          }
        },
        { threshold },
      );
      io.observe(el);
      return () => io.disconnect();
    } catch {
      setInView(true);
    }
    // Runs once — getEl is read a single time, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return inView;
}
