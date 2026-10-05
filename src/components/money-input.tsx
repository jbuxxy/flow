"use client";

import { useLayoutEffect, useRef, useState } from "react";

const MAX_DIGITS = 11; // up to $999,999,999.99 — comfortably above anything a household enters

function formatDigits(digits: string): string {
  if (!digits) return "";
  const cents = parseInt(digits, 10);
  const dollars = Math.floor(cents / 100);
  const centsPart = cents % 100;
  return `$${dollars.toLocaleString("en-US")}.${String(centsPart).padStart(2, "0")}`;
}

// Calculator/POS-style money entry: every digit typed appends on the right
// (cents-first), shifting existing digits left as the amount grows — e.g.
// typing "1", "2", "3" in sequence shows $0.01, then $0.12, then $1.23.
// Re-deriving the digit string from the raw input value on every change
// (rather than intercepting keydown) makes typing, backspace, delete, paste,
// and mobile soft keyboards all behave consistently for free. The formatted
// display doubles as the field's own submitted value — parseDollarsToCents
// already strips $ and , — so no hidden shadow input is needed. Cursor is
// pinned to the end after every change since this format only supports
// append/backspace-from-the-right, not meaningful mid-string editing.
export function MoneyInput({
  name,
  defaultCents,
  required,
  placeholder = "$0.00",
  className,
  disabled,
  onValueChange,
  "aria-label": ariaLabel,
}: {
  name?: string;
  defaultCents?: number;
  required?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  // Fires on every edit with a plain decimal string ("12.34", or "" when
  // empty) — for controlled callers that don't submit via a native form
  // (e.g. filters that push the value into a URL query). parseDollarsToCents
  // / parseFloat both accept this shape.
  onValueChange?: (value: string) => void;
}) {
  const [digits, setDigits] = useState(() =>
    defaultCents !== undefined ? String(Math.max(Math.round(defaultCents), 0)) : "",
  );
  const ref = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  });

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      name={name}
      value={formatDigits(digits)}
      onChange={(e) => {
        const next = e.target.value.replace(/\D/g, "").slice(0, MAX_DIGITS);
        setDigits(next);
        onValueChange?.(next ? (parseInt(next, 10) / 100).toFixed(2) : "");
      }}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
    />
  );
}
