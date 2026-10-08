"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { restoreScrollIfJumped } from "@/lib/preserve-scroll";

export type SelectOption = { value: string; label: string; group?: string };

// A custom-styled stand-in for native <select> — same trigger + absolute-
// panel shape as CategoryPicker (src/app/bills/category-picker.tsx), but
// the trigger is a real <input> so typing filters the option list (long
// lists like vehicle Year/Make are the whole reason this exists — nobody
// wants to scroll a 47-item year list by hand). Exists because native
// <select> popups are OS/browser-drawn chrome, not something CSS can fully
// control: `color-scheme` is supposed to theme them for dark mode, but
// mobile browsers (iOS Safari/Chrome most notably) render the picker
// following the *device's* system appearance instead, ignoring the page
// entirely — and native popup width is never something CSS can constrain,
// which is why it was overflowing its input's border on mobile. Panel here
// is `w-full` (matches the trigger exactly), so it physically cannot
// overflow, and it's plain Tailwind, so dark mode "just works" the same
// way the rest of the page does.
export function SelectField({
  options,
  value,
  onChange,
  name,
  placeholder = "Select…",
  disabled = false,
  small = false,
  large = false,
  className = "",
  searchable = true,
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Matches dense inline-edit rows (text-xs, e.g. bill-row.tsx's edit form). */
  small?: boolean;
  /** Matches top-level "Add X" forms (text-base py-2.5 px-3, e.g. add-asset-form.tsx's other fields) — the default otherwise undersizes next to them. */
  large?: boolean;
  className?: string;
  /** Set false for a small fixed set of options (e.g. a 3-way strategy
   * picker) where "type to filter" isn't useful — it just leaves the box
   * showing whatever was typed with nothing left to click if it doesn't
   * match. The trigger stays a real input (arrow-key/Enter selection still
   * works) but `readOnly`, so typing does nothing instead of filtering. */
  searchable?: boolean;
}) {
  const selected = options.find((o) => o.value === value) ?? null;

  const [open, setOpen] = useState(false);
  // Only meaningful while `open` — the in-progress filter query. Whenever
  // closed, the box just shows `selected`'s label directly (derived below,
  // not synced via effect), which is what makes the value changing from
  // outside (e.g. the Model list resetting when Make changes) and
  // discarding an unmatched filter "just work" for free.
  const [filterText, setFilterText] = useState("");
  // False right after opening — the box is pre-filled with the current
  // selection's label (for select-all-to-overwrite), but that pre-fill
  // must NOT itself act as a filter, or opening a field that already has a
  // value (Condition defaulting to "Good", say) would immediately narrow
  // the list down to just that one option instead of showing all of them.
  // Only real typing (the onChange handler) flips this to true.
  const [edited, setEdited] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown — a touch tap on iOS synthesizes mousedown/
    // click well after pointerdown/touchstart, so a mousedown-based outside-
    // click listener can end up racing an option button's own tap handling
    // in a way that's inconsistent across engines (real report, 2026-09-13:
    // choosing an option left the panel open on an iPhone). pointerdown
    // fires first and uniformly for mouse/touch/pen, same fix applied to
    // DayOfMonthPicker/CategoryPicker's identical listener.
    function onPointerDownOutside(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    return () => document.removeEventListener("pointerdown", onPointerDownOutside);
  }, [open]);

  const displayText = open ? filterText : (selected?.label ?? "");
  const filtered = edited && filterText.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(filterText.trim().toLowerCase()))
    : options;

  // Blurs the trigger once a pick is made: it's a text input (readonly for
  // a non-searchable field), and iOS Safari threw the page back to the top
  // when the row around a still-focused one grew on the pick (household
  // report, 2026-10-07: Move on /transactions — picking the bucket jumped
  // to the top as the Category picker and routing toggle appeared; the
  // Category picker, a plain button, never did). Reopening already works
  // from a plain click (see onClick below), so nothing needs the focus. The
  // scroll restore is the backstop if the page jumps anyway. A keyboard
  // pick (Enter) keeps focus, so tabbing on from the field still works.
  function choose(option: SelectOption, { keepFocus = false }: { keepFocus?: boolean } = {}) {
    const y = window.scrollY;
    onChange(option.value);
    setOpen(false);
    if (!keepFocus) inputRef.current?.blur();
    restoreScrollIfJumped(y);
  }

  function openField() {
    setOpen(true);
    setFilterText(selected?.label ?? "");
    setEdited(false);
    setHighlight(0);
    // Select-all so the first keystroke replaces the current value instead
    // of editing into the middle of it — same as a browser URL bar. Only
    // meaningful when typing does anything; for a non-searchable field this
    // just left the trigger looking like a highlighted text field (and,
    // since choosing an option doesn't blur the input, the leftover
    // selection meant a second click had no focus transition to reopen on).
    if (searchable) requestAnimationFrame(() => inputRef.current?.select());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openField();
      else setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && filtered[highlight]) {
        e.preventDefault();
        choose(filtered[highlight], { keepFocus: true });
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  // The default size pins an explicit height (matching this app's own
  // `h-[38px]` convention for a sibling `<input type="date">` in the same
  // row, e.g. add-debt-form.tsx/manual-debt-editor.tsx) instead of trusting
  // `py-2 text-sm` to compute the identical height on its own — it usually
  // does (20px line-height + 16px padding + 2px border = 38px), but this
  // trigger's an `<input>` sitting next to DayOfMonthPicker's `<button>`
  // trigger in the same grid row, and browser UA default button/input
  // metrics don't reliably match pixel-for-pixel across engines even with
  // identical Tailwind classes (real report, 2026-09-12: a row mixing this
  // with DayOfMonthPicker read visibly uneven on mobile). small/large stay
  // implicit-height, unchanged — no report of either ever misaligning.
  const triggerCls = small
    ? "text-xs py-1.5 pl-2 pr-7"
    : large
      ? "text-base py-2.5 pl-3 pr-9"
      : "h-[38px] text-sm py-2 pl-2 pr-7";

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <div className="relative">
        {/* The visible input has to come before the hidden one in DOM order
            — several call sites wrap this whole component in a bare
            <label>, which implicitly associates with the first labelable
            descendant. A hidden input listed first would silently steal
            that association instead of focusing the box you can see. */}
        <input
          ref={inputRef}
          type="text"
          value={displayText}
          onChange={(e) => {
            setFilterText(e.target.value);
            setEdited(true);
            setHighlight(0);
            if (!open) setOpen(true);
          }}
          onFocus={openField}
          // A keyboard pick (Enter) leaves the trigger focused, so a second
          // pick gets no focus event to reopen on — only `onFocus` handled
          // that. Re-derive it from a plain click too.
          onClick={() => {
            if (!open) openField();
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          readOnly={!searchable}
          placeholder={placeholder}
          autoComplete="off"
          className={`w-full rounded-lg border border-neutral-300 dark:border-neutral-700 ${triggerCls} placeholder:text-gray-400 dark:placeholder:text-neutral-500 focus:border-blue-900 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
            searchable ? "" : "select-none caret-transparent cursor-pointer"
          }`}
        />
        <ChevronDown
          size={small ? 12 : large ? 16 : 14}
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-neutral-400 ${large ? "right-3" : "right-2"}`}
        />
      </div>
      {name && <input type="hidden" name={name} value={value} />}

      {open && !disabled && (
        // --z-dropdown (globals.css) — has to beat RowActions' always-on
        // content strip (every row, whether that row's own actions are open
        // or not, is `relative z-10` with no isolating stacking context
        // between rows, so a *later* row's plain strip was painting over an
        // *earlier* row's open dropdown, real report 2026-09-05) and every
        // fixed/absolute overlay in the app — the nav/header, PWA install
        // banner, profile menu — or one of them sits on top of this panel
        // near the edge of the screen, hiding the last options and
        // swallowing the touch-scroll meant for the list underneath (real
        // report, 2026-09-09: couldn't scroll to an option near the bottom
        // of the screen).
        <div className="absolute z-[var(--z-dropdown)] mt-1 w-full min-w-[8rem] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm shadow-lg">
          <ul className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-1.5 text-xs text-gray-400 dark:text-neutral-500">No matches</li>
            ) : (
              groupOptions(filtered).map((g) => (
                <li key={g.name ?? "_"}>
                  {g.name && (
                    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {g.name}
                    </div>
                  )}
                  <ul>
                    {g.items.map(({ option, index }) => (
                      <li key={option.value}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(option)}
                          className={`block w-full truncate px-3 py-1.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800 ${
                            index === highlight ? "bg-neutral-50 dark:bg-neutral-800" : ""
                          } ${option.value === value ? "font-medium text-blue-900 dark:text-blue-300" : ""}`}
                        >
                          {option.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// Groups while preserving first-appearance order, both of groups and of
// options within each — plain flat rendering (one implicit `name: null`
// group) when no option carries a `group`, which is the common case.
function groupOptions(
  options: SelectOption[],
): { name: string | null; items: { option: SelectOption; index: number }[] }[] {
  const groups: { name: string | null; items: { option: SelectOption; index: number }[] }[] = [];
  const byName = new Map<string | null, (typeof groups)[number]>();
  options.forEach((option, index) => {
    const name = option.group ?? null;
    let g = byName.get(name);
    if (!g) {
      g = { name, items: [] };
      byName.set(name, g);
      groups.push(g);
    }
    g.items.push({ option, index });
  });
  return groups;
}
