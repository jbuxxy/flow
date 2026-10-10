"use client";

import { useRef, useState } from "react";

// A percent typed left-to-right like you'd read it off a statement — "2",
// ".", "6", "2", "5" shows 2.625% as you go — rather than MoneyInput's
// cents-first digit-shifting (which suits money, where you rarely know the
// decimal position in advance, but made editing a rate you already know
// exactly, like a 2.625% mortgage, awkward: no mid-string editing, and the
// value is always rebuilt from the right). Only the trailing "%" and
// rounding to 2 decimals — the server's real storage precision, see
// parsePercentToBasisPoints (money.ts) — are normalized, and only on blur, so a value
// typed with more precision (2.625) still round-trips through Number()
// correctly if the form submits before blur fires (e.g. Enter-to-submit).
export function PercentInput({
  name,
  defaultPercent,
  required,
  placeholder = "0.00%",
  className,
  disabled,
}: {
  name: string;
  defaultPercent?: number;
  required?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(() => (defaultPercent !== undefined ? `${defaultPercent.toFixed(2)}%` : ""));
  const ref = useRef<HTMLInputElement>(null);

  return (
    <input
      ref={ref}
      type="text"
      inputMode="decimal"
      name={name}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        if (/^\d*\.?\d*%?$/.test(raw)) setText(raw);
      }}
      onFocus={() => requestAnimationFrame(() => ref.current?.select())}
      onBlur={() => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const value = Number(trimmed.replace(/%/g, ""));
        if (Number.isFinite(value)) setText(`${value.toFixed(2)}%`);
      }}
      placeholder={placeholder}
      required={required}
      disabled={disabled}
      className={className}
    />
  );
}
