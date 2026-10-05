"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Bookmark, Check, X } from "lucide-react";
import { updateTransactionLabel } from "@/app/buckets/actions";
import { showToast } from "@/lib/toast";

// Split into a trigger (the bookmark icon, sits inline in a row's title)
// and a panel (the actual text input, animates open as its own row between
// the title and subtitle lines) sharing one editing state — so a caller
// whose title line has no spare width for a text input (a long merchant/P2P
// name) can place them in different spots instead of the input floating as
// an absolute-positioned overlay on top of other content, which is what
// this used to do. The panel is always mounted (grid-template-rows 0fr ->
// 1fr, not a conditional unmount) so it animates open AND closed — an
// unmount/remount only animates the open half.
export function useTransactionLabelEditor(
  transactionId: string,
  label: string | null,
  suggestions: string[],
) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label ?? "");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const datalistId = `label-suggestions-${transactionId}`;

  // autoFocus only fires on mount — this panel stays mounted (collapsed)
  // the whole time so it can animate, so focus has to be driven off the
  // `editing` transition instead.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = () =>
    startTransition(async () => {
      try {
        await updateTransactionLabel(transactionId, value);
        setEditing(false);
        showToast("Label Saved");
      } catch {
        showToast("Something Went Wrong", "error");
      }
    });
  const cancel = () => {
    setValue(label ?? "");
    setEditing(false);
  };

  // Hidden while the panel below is open — its own bookmark icon + Cancel
  // (X) already cover "close," so showing this too was just the same label
  // rendered twice at once, right above the input editing it (household
  // report, 2026-09-14).
  const trigger = editing ? null : (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      aria-label={label ? `Edit Label: ${label}` : "Add Label"}
      title={label ?? "Add Label"}
      className={`inline-flex min-w-0 items-center gap-1 text-xs ${
        label ? "text-blue-900 dark:text-blue-300" : "text-neutral-400 dark:text-neutral-600"
      }`}
    >
      <Bookmark size={11} className="shrink-0" />
      {label && <span className="min-w-0 truncate">{label}</span>}
    </button>
  );

  const panel = (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: editing ? "1fr" : "0fr" }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-2 py-1.5">
          <Bookmark size={12} className="shrink-0 text-blue-900 dark:text-blue-300" />
          <input
            ref={inputRef}
            list={datalistId}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              } else if (e.key === "Escape") {
                cancel();
              }
            }}
            placeholder="e.g. Sarah's lunch"
            maxLength={120}
            tabIndex={editing ? 0 : -1}
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-xs focus:border-blue-900 focus:outline-none dark:border-neutral-700"
          />
          {suggestions.length > 0 && (
            <datalist id={datalistId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          <button
            type="button"
            onClick={save}
            disabled={pending}
            aria-label="Save Label"
            title="Save"
            className="shrink-0 text-blue-900 dark:text-blue-300"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={cancel}
            aria-label="Cancel Editing Label"
            title="Cancel"
            className="shrink-0 text-neutral-500 dark:text-neutral-400"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );

  return { editing, trigger, panel };
}

// Self-contained trigger+panel stacked one after the other — for a caller
// whose title line already has room to just render this as its own block
// (see useTransactionLabelEditor above for the split version, used where
// the trigger needs to sit inline in a title row and the panel needs to
// land somewhere else, e.g. between that title and the subtitle below it).
export function TransactionLabelEditor({
  transactionId,
  label,
  suggestions,
}: {
  transactionId: string;
  label: string | null;
  suggestions: string[];
}) {
  const { trigger, panel } = useTransactionLabelEditor(transactionId, label, suggestions);
  return (
    <>
      {trigger}
      {panel}
    </>
  );
}
