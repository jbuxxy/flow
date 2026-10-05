"use client";

// The toggle-switch look already used inline in a few places (account-editor,
// manual-debt-editor, transaction-filters) — pulled out here so new toggles
// (NotificationToggle, the income-calc P2P setting) don't grow a fourth copy
// of the same markup.
export function Switch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  // A plain <span> wrapper never forwarded a click on the visible pill to
  // the sr-only checkbox — only <label> does that natively for a descendant
  // form control. Every Switch in the app (notification prefs, income
  // settings, payoff planner, onboarding) was effectively unclickable by
  // mouse/touch as a result — real household report, 2026-09-25: "I can't
  // toggle any notifications." Keyboard activation (Tab + Space) still
  // worked, since that targets the focused input directly regardless of its
  // visual position, which is why this went unnoticed for a month.
  return (
    <label
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-blue-900 dark:bg-blue-700" : "bg-neutral-300 dark:bg-neutral-700"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={ariaLabel}
        className="sr-only"
      />
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </label>
  );
}
