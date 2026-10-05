"use client";

// Height-and-fade collapse for an element on its way out. Render it with
// `show` and flip it to `false` to start the collapse; it calls `onExited`
// once the transition finishes so the caller can drop the item from its
// list (a two-stage remove: animate first, unmount after). Nothing happens
// on mount — a freshly rendered `show` element just appears, no intro
// animation.
//
// Uses the grid `1fr` → `0fr` trick so it can animate to the content's
// natural height without measuring it. The inner wrapper's
// `min-h-0 overflow-hidden` is what actually clips the content as the row
// collapses. `onExited` is triggered off the `opacity` transition, not
// `grid-template-rows`, because opacity is transitionable everywhere while
// animated grid tracks are newer — the collapse still animates via the
// grid rows, we just don't depend on that property firing transitionend.
export function CollapseOnExit({
  show,
  onExited,
  children,
  className,
}: {
  show: boolean;
  onExited: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      onTransitionEnd={(e) => {
        if (!show && e.target === e.currentTarget && e.propertyName === "opacity") onExited();
      }}
      className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
        show ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }${className ? ` ${className}` : ""}`}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
