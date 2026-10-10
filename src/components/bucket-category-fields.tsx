"use client";

import { SelectField } from "@/components/select-field";
import { CategoryPicker, type CategoryOption } from "@/app/bills/category-picker";

const LABEL_CLS = "flex min-w-0 flex-col gap-1 text-xs text-gray-500 dark:text-neutral-400";

// The Bucket · Category pair every bill / debt / BNPL form ends with — Bucket
// first, then a category picker scoped to the picked bucket (the fixed form
// field order). Six forms used to hand-roll it. Submits `bucketId` and
// `categoryId` as form fields.
//
// allowNoBucket: adds a "None" bucket option, and the category slot reads
// "Pick A Bucket First" until one is picked (a bill row). Without buckets at
// all only the category picker renders — unless hideWithoutBuckets.
export function BucketCategoryFields({
  buckets,
  bucketId,
  onBucketChange,
  categories,
  defaultCategoryId,
  allowNoBucket = false,
  hideWithoutBuckets = false,
  small = false,
}: {
  buckets: { id: string; name: string }[];
  bucketId: string;
  onBucketChange: (bucketId: string) => void;
  categories: CategoryOption[];
  defaultCategoryId: string | null;
  allowNoBucket?: boolean;
  hideWithoutBuckets?: boolean;
  small?: boolean;
}) {
  if (hideWithoutBuckets && buckets.length === 0) return null;
  return (
    <div className={buckets.length > 0 ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2"}>
      {buckets.length > 0 && (
        <label className={LABEL_CLS}>
          Bucket
          <SelectField
            name="bucketId"
            value={bucketId}
            onChange={onBucketChange}
            options={[
              ...(allowNoBucket ? [{ value: "", label: "None" }] : []),
              ...buckets.map((b) => ({ value: b.id, label: b.name })),
            ]}
            className="mt-1"
            small={small}
          />
        </label>
      )}
      <label className={LABEL_CLS}>
        Category
        <div className="mt-1">
          {allowNoBucket && !bucketId ? (
            <p className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-xs text-gray-400 dark:text-neutral-500">
              Pick A Bucket First
            </p>
          ) : (
            <CategoryPicker
              key={bucketId}
              categories={categories.filter((c) => c.bucketId === bucketId)}
              defaultCategoryId={defaultCategoryId}
              bucketId={bucketId || null}
              name="categoryId"
              small={small}
            />
          )}
        </div>
      </label>
    </div>
  );
}
