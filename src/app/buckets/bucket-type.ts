// The bucket "type" picker shared by the Add-a-Bucket modal
// (add-bucket-form.tsx) and per-bucket Settings (bucket-settings-form.tsx).
// "One-Time Purchase" is the 4th pick rather than a separate checkbox
// (household request, 2026-09-08) — on submit it maps to trackingMode SPEND
// + excludedFromAllocation (see Bucket.excludedFromAllocation, createBucket,
// updateBucketSettings).

export type BucketType = "SPEND" | "RECURRING" | "MIXED" | "ONE_TIME";

export const BUCKET_TYPE_OPTIONS: { value: BucketType; label: string }[] = [
  { value: "SPEND", label: "Singles" },
  { value: "RECURRING", label: "Recurring" },
  { value: "MIXED", label: "Mixed" },
  { value: "ONE_TIME", label: "One-Time Purchase" },
];

// Shown under the dropdown, describing whatever's selected.
export const BUCKET_TYPE_DESCRIPTION: Record<BucketType, string> = {
  SPEND: "Everyday spending. Transactions auto-file here and show in the Singles list.",
  RECURRING:
    "Bills and subscriptions. A matching charge is suggested as a recurring bill to track — it never auto-files here, and there's no Singles list.",
  MIXED:
    "Both. Single charges auto-file into the Singles list; a recurring charge is suggested as a bill to track and then shows as a bill card above.",
  ONE_TIME:
    "Doesn't count toward this month's spending budget. It's funded from savings or checking instead of this month's regular income, so it's left out of Set the Month (the budget you review and confirm at the start of each period), your savings capacity, and the Total Allocated vs. Income card. A car down payment, a big repair, that kind of thing — a matching charge auto-files here on its own.",
};
