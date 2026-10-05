"use client";

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";

// A regular on/off switch that an owner can also *lock* where it sits
// (household request, 2026-10-03): tap flips it as usual; press and hold
// (HOLD_MS) locks it in its current position — a ring fills around the thumb
// while holding, then a lock icon sits on the thumb. Holding a locked switch
// unlocks it the same way. Keyboard: Space/Enter flips, "L" toggles the lock.
//
// `onLockChange` omitted = a plain switch with no lock gesture (a member's
// own view, or the owner's own switch). A locked switch with no
// `onLockChange` is inert — the member it belongs to can't change it.

const HOLD_MS = 700;
const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;

export function LockableSwitch({
  checked,
  locked,
  onToggle,
  onLockChange,
  disabled = false,
  ariaLabel,
  onLockedTap,
}: {
  checked: boolean;
  locked: boolean;
  onToggle: () => void;
  onLockChange?: (locked: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  // Tapped while locked — e.g. a "Hold To Unlock" hint for the owner.
  onLockedTap?: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const lockable = !!onLockChange && !disabled;

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function clearHold() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }

  function tap() {
    if (disabled) return;
    if (locked) {
      onLockedTap?.();
      return;
    }
    onToggle();
  }

  function toggleLock() {
    if (!lockable) return;
    onLockChange!(!locked);
    if (typeof navigator !== "undefined") navigator.vibrate?.(20);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${ariaLabel}${locked ? " (Locked)" : ""}`}
      title={lockable ? (locked ? "Locked — Hold To Unlock" : "Hold To Lock") : locked ? "Locked By The Owner" : undefined}
      disabled={disabled && !locked}
      onPointerDown={(e) => {
        if (e.button !== 0 || disabled) return;
        fired.current = false;
        if (!lockable) return;
        setHolding(true);
        timer.current = setTimeout(() => {
          fired.current = true;
          timer.current = null;
          setHolding(false);
          toggleLock();
        }, HOLD_MS);
      }}
      onPointerUp={() => {
        const wasHolding = timer.current !== null;
        clearHold();
        if (!fired.current && (wasHolding || !lockable)) tap();
      }}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        // Pointer handlers already acted; only a keyboard "click" (detail 0)
        // falls through to here.
        if (e.detail === 0) tap();
      }}
      onKeyDown={(e) => {
        if (e.key.toLowerCase() === "l") {
          e.preventDefault();
          toggleLock();
        }
      }}
      className={`relative inline-flex h-7 w-12 shrink-0 touch-none select-none items-center rounded-full transition-colors [-webkit-touch-callout:none] ${
        checked ? "bg-blue-900 dark:bg-blue-700" : "bg-neutral-300 dark:bg-neutral-700"
      } ${disabled && !locked ? "opacity-50" : ""} ${locked && !lockable ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-white shadow transition-transform duration-200 ${
          checked ? "translate-x-5" : "translate-x-0"
        } ${holding ? "scale-95" : ""}`}
      >
        {locked && (
          <Lock size={12} strokeWidth={2.5} className={checked ? "text-blue-900" : "text-neutral-500"} />
        )}
        {/* Hold progress — fills over HOLD_MS while the finger stays down. */}
        <svg
          aria-hidden
          viewBox="0 0 34 34"
          className={`pointer-events-none absolute -inset-[5px] h-[34px] w-[34px] -rotate-90 transition-opacity ${
            holding ? "opacity-100" : "opacity-0"
          }`}
        >
          <circle
            cx="17"
            cy="17"
            r={RING_R}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="stroke-amber-500"
            strokeDasharray={RING_C}
            strokeDashoffset={holding ? 0 : RING_C}
            style={{ transition: holding ? `stroke-dashoffset ${HOLD_MS}ms linear` : "none" }}
          />
        </svg>
      </span>
    </button>
  );
}
