"use client";

import { SelectField } from "@/components/select-field";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";

// The "where does this transaction go" picker every Move/Reclassify panel
// shares — the bucket page's row, /transactions' row and the Needs a Bucket
// queue each used to carry their own copy. A "bucket:<id>" / "debt:<id>"
// selection, plus a category picker scoped to the chosen bucket. The save
// button stays with each caller (their save flows genuinely differ: routing
// rules, make-rule toggles, scroll preservation).
//
// `buckets` is already filtered by the caller (RECURRING buckets never take a
// plain move — reassignTransaction rejects them; a non-budget-tracked
// account's charge gets none at all). `currentBucketId` marks the row's own
// bucket "(Current)".
export function MoveTargetPicker({
  selection,
  onSelectionChange,
  buckets,
  debts,
  categories,
  categoryId,
  onCategoryChange,
  currentBucketId,
  allowCategory = true,
}: {
  selection: string;
  onSelectionChange: (value: string) => void;
  buckets: { id: string; name: string }[];
  debts: { id: string; name: string }[];
  categories: CategoryOption[];
  categoryId: string | null;
  onCategoryChange: (categoryId: string | null) => void;
  currentBucketId?: string | null;
  allowCategory?: boolean;
}) {
  const bucketId = selection.startsWith("bucket:") ? selection.slice("bucket:".length) : null;
  return (
    <>
      <SelectField
        value={selection}
        onChange={onSelectionChange}
        small
        searchable={false}
        options={[
          ...buckets.map((b) => ({
            value: `bucket:${b.id}`,
            label: b.id === currentBucketId ? `${b.name} (Current)` : b.name,
            group: "Bucket",
          })),
          ...debts.map((d) => ({ value: `debt:${d.id}`, label: d.name, group: "Debt Payment" })),
        ]}
        className="min-w-0 flex-1"
      />
      {allowCategory && bucketId && (
        <div className="w-32 shrink-0">
          <CategoryPicker
            key={selection}
            categories={categories.filter((c) => c.bucketId === bucketId)}
            defaultCategoryId={categoryId}
            bucketId={bucketId}
            onSelect={onCategoryChange}
            small
          />
        </div>
      )}
    </>
  );
}
