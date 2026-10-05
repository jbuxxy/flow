"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { createBillCategory, deleteBillCategory } from "./actions";
import { showToast } from "@/lib/toast";

export type CategoryOption = { id: string; name: string; bucketId?: string | null };

// Gmail-label-style: the dropdown IS the manager — pick a category, add a
// new one on the spot (opens a small modal for the name), or delete one
// right from the same list, wherever this picker appears. No separate
// "manage categories" page needed. Deleting a category never touches the
// bills using it (see BillCategory's onDelete: SetNull on the schema side)
// — they just show as "Uncategorized".
//
// Each instance keeps its own local copy of the category list (seeded from
// the server-fetched `categories` prop) so a category created here shows up
// immediately in *this* picker without a full page reload — same tradeoff
// the old SubcategoryManager made. Other picker instances on the same page
// pick it up next time the page re-renders from the server, not live.
//
// `categories` is always expected pre-filtered to the relevant bucket by
// the caller (single-bucket contexts filter once server-side; multi-bucket
// contexts — a Reclassify row that can move between buckets — filter
// client-side by whichever bucket is currently selected, recomputed on
// every change) — this component never filters on its own, only renders
// whatever list it's handed (see the schema comment on
// BillCategory.bucketId). `bucketId` is that same currently-relevant
// bucket, used only to scope a "+ New category" creation — hidden
// entirely when null (nothing to scope a new category to yet, e.g. no
// bucket picked in a Reclassify row).
export function CategoryPicker({
  categories: initialCategories,
  defaultCategoryId = null,
  bucketId = null,
  name,
  onSelect,
  small = false,
}: {
  categories: CategoryOption[];
  defaultCategoryId?: string | null;
  bucketId?: string | null;
  name?: string;
  onSelect?: (categoryId: string | null) => void;
  small?: boolean;
}) {
  const [categories, setCategories] = useState(initialCategories);
  const [selectedId, setSelectedId] = useState<string | null>(defaultCategoryId);
  const [open, setOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // pointerdown, not mousedown — see the identical fix/comment on
    // SelectField's own outside-click listener (select-field.tsx).
    function onPointerDownOutside(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDownOutside);
    return () => document.removeEventListener("pointerdown", onPointerDownOutside);
  }, [open]);

  const selected = categories.find((c) => c.id === selectedId) ?? null;
  // Default was py-2.5 (42px tall) — SelectField's own default is py-2
  // (38px), and the two are paired in the exact same "Bucket · Category"
  // row throughout the app (manual-debt-editor.tsx and others; see the
  // "Bucket·Category" fixed field order) — the mismatch read as a visibly
  // taller box on one side of that row (real report, 2026-09-12). Matched
  // to SelectField's default exactly, height included, so the two always
  // line up regardless of which one a given row happens to render first.
  const triggerCls = small ? "text-xs py-1.5" : "h-[38px] text-sm py-2";

  function select(id: string | null) {
    setSelectedId(id);
    onSelect?.(id);
    setOpen(false);
  }

  function submitNewCategory() {
    const trimmed = newName.trim();
    if (!trimmed || !bucketId) return;
    startTransition(async () => {
      const result = await createBillCategory(bucketId, trimmed);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.category) {
        const created = result.category;
        setCategories((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        select(created.id);
      }
      setNewName("");
      setError(null);
      setModalOpen(false);
      showToast("Category Added");
    });
  }

  function removeCategory(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Any bill using it just loses the category.`)) return;
    setDeletingId(id);
    startTransition(async () => {
      try {
        await deleteBillCategory(id);
        setCategories((prev) => prev.filter((c) => c.id !== id));
        if (selectedId === id) select(null);
        showToast("Category Deleted");
      } catch {
        showToast("Something Went Wrong", "error");
      }
      setDeletingId(null);
    });
  }

  return (
    <div className="relative" ref={containerRef}>
      {name && <input type="hidden" name={name} value={selectedId ?? ""} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 ${triggerCls} focus:border-blue-900 focus:outline-none`}
      >
        <span className={`truncate ${selected ? "" : "text-gray-400 dark:text-neutral-500"}`}>
          {selected?.name ?? "Uncategorized"}
        </span>
        <ChevronDown size={small ? 12 : 14} className="shrink-0 text-neutral-400" />
      </button>

      {open && (
        // --z-dropdown (globals.css) — a lower tier here let the fixed nav/
        // header, then the PWA install banner, each in turn sit on top of
        // this panel near the edge of the screen, hiding the last options
        // *and* swallowing the touch-scroll meant for the list underneath
        // (real report, 2026-09-09: couldn't scroll to a category near the
        // bottom of the screen).
        <div className="absolute z-[var(--z-dropdown)] mt-1 w-full min-w-[10rem] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-sm shadow-lg">
          {categories.length > 0 && (
            <ul className="max-h-56 overflow-y-auto py-1">
              {categories.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  <button type="button" onClick={() => select(c.id)} className="flex-1 truncate text-left">
                    {c.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeCategory(c.id, c.name)}
                    disabled={deletingId === c.id}
                    aria-label={`Delete ${c.name}`}
                    title="Delete — any bill using it just loses the category"
                    className="shrink-0 text-red-600 dark:text-red-400 disabled:opacity-50"
                  >
                    {deletingId === c.id ? <span aria-label="Removing">…</span> : <Trash2 size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {bucketId && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setModalOpen(true);
              }}
              className="flex w-full items-center gap-1.5 border-t border-neutral-100 dark:border-neutral-800 px-3 py-2 font-medium text-blue-800 dark:text-blue-400"
            >
              <Plus size={14} /> New Category
            </button>
          )}
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-black/40 px-4"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="w-full max-w-xs rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold text-emerald-700 dark:text-emerald-400">New Category</h3>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitNewCategory();
                }
              }}
              placeholder="e.g. Card payment"
              className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
            />
            {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setModalOpen(false);
                  setError(null);
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitNewCategory}
                disabled={pending || !newName.trim()}
                className="rounded-lg bg-blue-900 dark:bg-blue-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {pending ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
