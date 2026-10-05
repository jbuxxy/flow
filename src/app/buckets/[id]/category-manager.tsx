"use client";

import { useState, useTransition } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { createBillCategory, updateBillCategory, deleteBillCategory } from "@/app/bills/actions";
import { showToast } from "@/lib/toast";
import type { CategoryOption } from "@/app/bills/category-picker";
import { RowActions, type RowAction } from "@/components/row-actions";

// A plain always-visible rename/add/delete list, distinct from
// CategoryPicker's own combobox-with-a-manager-inside-the-dropdown
// (src/app/bills/category-picker.tsx) — this one's the destination, not a
// side effect of picking a value, so it doesn't need to be tucked behind a
// trigger button. Reuses the exact same createBillCategory/deleteBillCategory
// actions CategoryPicker already calls, plus the new updateBillCategory
// (2026-08-23, household request — "rename categories from a bucket's
// settings") for the one thing CategoryPicker never offered: a rename is a
// pure label change (categoryId never moves), so every bill/debt payment/
// transaction/pattern/merchant rule already pointing at it just shows the
// new name everywhere, nothing to re-link.
//
// Categories are bucket-scoped (2026-08-23 — see the schema comment on
// BillCategory.bucketId; previously household-wide, which meant a Dining
// bucket's own picker showed Bills' categories like "BNPL"/"Card Payment").
// `categories` is expected pre-filtered to this bucket by the caller.
export function CategoryManager({ bucketId, categories: initial }: { bucketId: string; categories: CategoryOption[] }) {
  const [categories, setCategories] = useState(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startEdit(c: CategoryOption) {
    setEditingId(c.id);
    setEditingName(c.name);
    setError(null);
  }

  function saveEdit(id: string) {
    const trimmed = editingName.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await updateBillCategory(id, trimmed);
      if (result.error) {
        setError(result.error);
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, name: trimmed } : c)).sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingId(null);
      setError(null);
      showToast("Category Saved");
    });
  }

  function addCategory() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await createBillCategory(bucketId, trimmed);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.category) {
        const created = result.category;
        setCategories((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setNewName("");
      setError(null);
      showToast("Category Added");
    });
  }

  function remove(id: string) {
    setDeletingId(id);
    startTransition(async () => {
      try {
        await deleteBillCategory(id);
        setCategories((prev) => prev.filter((c) => c.id !== id));
        showToast("Category Deleted");
      } catch {
        showToast("Something Went Wrong", "error");
      }
      setDeletingId(null);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Categories</p>
      {categories.length > 0 && (
        <ul className="flex flex-col gap-1">
          {categories.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2 py-1.5 text-sm"
            >
              {editingId === c.id ? (
                <>
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveEdit(c.id);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-1.5 py-0.5 text-sm focus:border-blue-900 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => saveEdit(c.id)}
                    disabled={pending}
                    aria-label="Save"
                    title="Save"
                    className="shrink-0 text-blue-800 dark:text-blue-400 disabled:opacity-50"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    aria-label="Cancel"
                    title="Cancel"
                    className="shrink-0 text-neutral-400 dark:text-neutral-500"
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <RowActions
                    dense
                    actions={
                      [
                        { key: "rename", icon: Pencil, label: "Rename", onClick: () => startEdit(c) },
                        {
                          key: "delete",
                          icon: Trash2,
                          label: "Delete",
                          tone: "danger",
                          // This row's own width (a short category label +
                          // Rename) leaves no room for a "Delete" word pill
                          // without it colliding with the kebab's own close
                          // X — see forceIcon's own comment. Still always
                          // red, still always confirm()-gated below.
                          forceIcon: true,
                          disabled: deletingId === c.id,
                          confirmMessage: `Delete "${c.name}"? Anything using it just loses the category.`,
                          onClick: () => remove(c.id),
                        },
                      ] satisfies RowAction[]
                    }
                  >
                    <span className="min-w-0 truncate">{c.name}</span>
                  </RowActions>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCategory();
            }
          }}
          placeholder="New category"
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm focus:border-blue-900 focus:outline-none"
        />
        <button
          type="button"
          onClick={addCategory}
          disabled={pending || !newName.trim()}
          className="shrink-0 rounded-lg border border-neutral-300 dark:border-neutral-700 px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
